"""Bounded, task-owned Windows Chrome fixture runner. Default mode only verifies hashes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import psutil
import ctypes
from ctypes import wintypes
import msvcrt

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "freeze.json"
HEAD = "cb12f370feb558002c7416ffe0087a9814e1b091"
LIMITS = {"proxyRssBytes": 512 * 1024**2, "treeRssBytes": 2 * 1024**3,
          "diskBytes": 2 * 1024**3, "suiteSeconds": 180, "sampleSeconds": 0.1}


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def verify(frozen=None):
    if frozen is None:
        frozen = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert frozen["sourceCommit"] == HEAD
    assert frozen["semanticTypecheck"]["exitCode"] == 0
    assert frozen["semanticTypecheck"]["fixtureSHA256"] == frozen["fixture"]["sha256"]
    assert {"package.json", "bun.lock"}.issubset({entry["path"] for entry in frozen["sourceClosure"]})
    repo = Path(frozen["repo"])
    items = [frozen[key] for key in ("fixture", "freezer", "chrome", "bun", "node", "readme")]
    items.append(frozen["chrome"]["engine"])
    items += frozen["attempt0"] + frozen["staticCheckArtifacts"] + frozen["priorPreparations"]
    items += frozen["dependencies"]
    items += [dict(item, path=str(repo / item["path"]))
              for key in ("sourceClosure", "inputs") for item in frozen[key]]
    failures = []
    for item in items:
        path = Path(item["path"])
        if not path.is_file() or path.stat().st_size != item["bytes"] or sha(path) != item["sha256"]:
            failures.append(str(path))
    assert not failures, "Frozen input mismatch: " + repr(failures)
    return frozen, len(items)


def disk_bytes(roots):
    total, skipped = 0, 0
    for root in roots:
        for directory, directories, filenames in os.walk(root, followlinks=False):
            directories[:] = [name for name in directories if not Path(directory, name).is_symlink()]
            for name in filenames:
                path = Path(directory, name)
                try:
                    if not path.is_symlink():
                        total += path.stat().st_size
                except (FileNotFoundError, NotADirectoryError):
                    skipped += 1
    return total, skipped


def matching_process(pid, stamp):
    try:
        process = psutil.Process(pid)
        return process if process.create_time() == stamp else None
    except psutil.NoSuchProcess:
        return None


class OwnedJob:
    """Suspend Bun until its new private Windows job owns it; descendants cannot escape it."""
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        k = self.kernel
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.SetInformationJobObject.restype = wintypes.BOOL
        k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        k.QueryInformationJobObject.restype = wintypes.BOOL
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateJobObject.restype = wintypes.BOOL
        k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateProcess.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        k.ResumeThread.argtypes = [wintypes.HANDLE]
        k.ResumeThread.restype = wintypes.DWORD
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        class Basic(ctypes.Structure):
            _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("minWorkingSet", ctypes.c_size_t), ("maxWorkingSet", ctypes.c_size_t),
                ("activeProcesses", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("ioCounters", ctypes.c_ulonglong * 6),
                ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]
        self.handle = k.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway permission.
        if not k.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            k.CloseHandle(self.handle)
            raise error
        self.process_handle = None
        self.pid, self.returncode = None, None

    def launch(self, args, cwd, env, log):
        class Startup(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("reserved", wintypes.LPWSTR), ("desktop", wintypes.LPWSTR),
                ("title", wintypes.LPWSTR), ("x", wintypes.DWORD), ("y", wintypes.DWORD),
                ("xSize", wintypes.DWORD), ("ySize", wintypes.DWORD), ("xChars", wintypes.DWORD),
                ("yChars", wintypes.DWORD), ("fill", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("show", wintypes.WORD), ("reservedSize", wintypes.WORD), ("reservedBytes", ctypes.c_void_p),
                ("stdin", wintypes.HANDLE), ("stdout", wintypes.HANDLE), ("stderr", wintypes.HANDLE)]
        class ProcessInfo(ctypes.Structure):
            _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE),
                        ("pid", wintypes.DWORD), ("tid", wintypes.DWORD)]
        k = self.kernel
        k.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
            wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
            ctypes.POINTER(Startup), ctypes.POINTER(ProcessInfo)]
        k.CreateProcessW.restype = wintypes.BOOL
        startup, info = Startup(), ProcessInfo()
        startup.cb = ctypes.sizeof(startup)
        startup.flags = 0x100  # STARTF_USESTDHANDLES
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(args))
        block = ctypes.create_unicode_buffer("\0".join(key + "=" + value for key, value in sorted(env.items(), key=lambda pair: pair[0].upper())) + "\0\0")
        with open(os.devnull, "rb") as null:
            handles = [msvcrt.get_osfhandle(null.fileno()), msvcrt.get_osfhandle(log.fileno())]
            startup.stdin, startup.stdout, startup.stderr = handles[0], handles[1], handles[1]
            for handle in handles:
                os.set_handle_inheritable(handle, True)
            try:
                ok = k.CreateProcessW(args[0], command, None, None, True,
                    0x4 | 0x400 | 0x08000000, block, str(cwd), ctypes.byref(startup), ctypes.byref(info))
            finally:
                for handle in handles:
                    os.set_handle_inheritable(handle, False)
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        self.pid, self.process_handle = info.pid, info.process
        try:
            if not k.AssignProcessToJobObject(self.handle, info.process):
                raise ctypes.WinError(ctypes.get_last_error())
            if k.ResumeThread(info.thread) == 0xffffffff:
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            k.TerminateProcess(info.process, 1)
            k.WaitForSingleObject(info.process, 5000)
            raise
        finally:
            k.CloseHandle(info.thread)
        return self

    def members(self):
        for capacity in (256, 1024, 4096, 16384):
            buffer = ctypes.create_string_buffer(8 + ctypes.sizeof(ctypes.c_size_t) * capacity)
            if self.kernel.QueryInformationJobObject(self.handle, 3, buffer, len(buffer), None):
                count = wintypes.DWORD.from_buffer(buffer, 4).value
                return list((ctypes.c_size_t * count).from_buffer(buffer, 8))
            if ctypes.get_last_error() != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(ctypes.get_last_error())
        raise RuntimeError("Owned job membership exceeds bounded query capacity")

    def poll(self):
        if self.returncode is None and self.process_handle and self.kernel.WaitForSingleObject(self.process_handle, 0) == 0:
            code = wintypes.DWORD()
            if not self.kernel.GetExitCodeProcess(self.process_handle, ctypes.byref(code)):
                raise ctypes.WinError(ctypes.get_last_error())
            self.returncode = code.value
        return self.returncode

    def wait(self, timeout):
        result = self.kernel.WaitForSingleObject(self.process_handle, int(timeout * 1000))
        if result != 0:
            raise TimeoutError("Owned Bun process wait did not complete: " + str(result))
        return self.poll()

    def terminate(self):
        if not self.kernel.TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        for handle in (self.process_handle, self.handle):
            if handle and not self.kernel.CloseHandle(handle):
                raise ctypes.WinError(ctypes.get_last_error())
        self.process_handle, self.handle = None, None


def run(run_id, selected_case="all"):
    frozen, checked = verify()
    manifest_before = sha(MANIFEST)
    supervisor_before = sha(__file__)
    repo = Path(frozen["repo"])
    name = "pr13-cb12-run" + str(run_id)
    run_root = HERE / (name + "-owned")
    output = repo / "output" / "playwright" / name
    result_path = HERE / (name + "-guard.json")
    assert not result_path.exists() and not run_root.exists() and not output.exists(), "Never overwrite a prior attempt"
    run_root.mkdir()
    output.mkdir(parents=True)
    (run_root / "ownership.json").write_text(json.dumps({"head": HEAD, "initialAbsent": True,
        "supervisorPid": os.getpid(), "run": run_id, "manifestSha256": sha(MANIFEST)}, indent=2) + "\n", encoding="utf-8")
    profile = run_root / "home"
    profile.mkdir()
    temporary = run_root / "tmp"
    temporary.mkdir()
    environment = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if key in os.environ}
    for key in ("HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_CHATGPT_WEB_HOME"):
        directory = profile / key.lower()
        directory.mkdir()
        environment[key] = str(directory)
    environment.update({key: str(temporary) for key in ("TMP", "TEMP", "TMPDIR")})
    environment.update(PR13_CHROME_FIXTURE_RUN="authorized", CHATGPT_DOM_TEST_BROWSER=frozen["chrome"]["path"],
                       PR13_CHROME_FIXTURE_OUTPUT=str(output), NO_COLOR="1")
    args = [frozen["bun"]["path"], "test", "tests/pr13-local-chrome.fixture.test.ts"]
    if selected_case == "shutdown":
        args += ["--test-name-pattern", "^Local Chrome: shutdown retains its listener until its owned Chrome child exits$"]
    samples, known = [], {}
    stop, error, cleanup_kills, cleanup_errors = None, None, [], []
    start = time.monotonic()
    last_disk, skipped, disk = 0, 0, 0
    child = None
    job = None
    lingering = []
    with (run_root / "harness.log").open("x", encoding="utf-8") as log:
        try:
            job = OwnedJob()
            child = job.launch(args, repo, environment, log)
            process = psutil.Process(child.pid)
            known[child.pid] = process.create_time()
            while child.poll() is None:
                current = {}
                for pid in job.members():
                    try:
                        owned = psutil.Process(pid)
                        known[pid] = owned.create_time()
                        current[pid] = owned
                    except psutil.NoSuchProcess:
                        pass
                rows = []
                for pid, owned in current.items():
                    try:
                        rows.append({"pid": pid, "start": known[pid], "rss": owned.memory_info().rss})
                    except psutil.NoSuchProcess:
                        pass
                # AccessDenied and other failures above are fatal: no silently unavailable memory guard.
                proxy = next((row["rss"] for row in rows if row["pid"] == child.pid), None)
                if proxy is None and child.poll() is None:
                    raise RuntimeError("RSS unavailable for live Bun process")
                elapsed = time.monotonic() - start
                if elapsed - last_disk >= 1 or not samples:
                    disk, missing = disk_bytes([run_root, output])
                    skipped += missing
                    last_disk = elapsed
                tree = sum(row["rss"] for row in rows)
                samples.append({"ms": round(elapsed * 1000), "proxyRss": proxy or 0, "treeRss": tree,
                                "diskBytes": disk, "processes": rows})
                if elapsed > LIMITS["suiteSeconds"]:
                    stop = "suite_deadline"
                elif (proxy or 0) > LIMITS["proxyRssBytes"] or tree > LIMITS["treeRssBytes"]:
                    stop = "rss_limit"
                elif disk > LIMITS["diskBytes"]:
                    stop = "disk_limit"
                if stop:
                    break
                time.sleep(LIMITS["sampleSeconds"])
        except BaseException as failure:
            error = repr(failure)
            stop = stop or "supervisor_error"
        finally:
            # The job was assigned before Bun resumed, so an early parent exit cannot lose descendants.
            if job:
                try:
                    lingering = [{"pid": pid} for pid in job.members()]
                    if lingering:
                        job.terminate()
                        cleanup_kills = lingering.copy()
                except BaseException as failure:
                    cleanup_errors.append({"stage": "job-enumerate-or-terminate", "error": repr(failure)})
                try:
                    if child:
                        child.wait(timeout=10)
                except BaseException as failure:
                    cleanup_errors.append({"stage": "root-wait", "error": repr(failure)})
                try:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and job.members():
                        time.sleep(0.1)
                    job_remaining = job.members()
                except BaseException as failure:
                    job_remaining = ["unavailable"]
                    cleanup_errors.append({"stage": "job-final-enumerate", "error": repr(failure)})
                try:
                    job.close()  # KILL_ON_JOB_CLOSE also applies if membership/termination monitoring failed.
                except BaseException as failure:
                    cleanup_errors.append({"stage": "job-close", "error": repr(failure)})
            else:
                job_remaining = []
    after, after_error = None, None
    try:
        assert sha(MANIFEST) == manifest_before, "Frozen manifest changed during execution"
        assert sha(__file__) == supervisor_before, "Supervisor source changed during execution"
        _, after = verify(frozen)
    except BaseException as failure:
        after_error = repr(failure)
    left = []
    for pid, stamp in known.items():
        try:
            if matching_process(pid, stamp):
                left.append({"pid": pid, "start": stamp})
        except BaseException as failure:
            cleanup_errors.append({"stage": "identity-final-check", "pid": pid, "error": repr(failure)})
    passed = child is not None and child.returncode == 0 and stop is None and not lingering and not left and not job_remaining and not cleanup_errors and after_error is None
    result = {"head": HEAD, "status": "PASS" if passed else "FAIL", "candidateBoundary": frozen["boundary"],
        "timeUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "manifestSha256Before": manifest_before,
        "manifestSha256After": sha(MANIFEST) if MANIFEST.is_file() else None,
        "supervisorSha256Before": supervisor_before, "supervisorSha256After": sha(__file__),
        "args": args, "runRoot": str(run_root), "output": str(output),
        "selectedCase": selected_case,
        "limits": LIMITS, "pid": child.pid if child else None, "exitCode": child.returncode if child else None,
        "elapsedMs": round((time.monotonic() - start) * 1000), "stopReason": stop, "error": error,
        "verifiedInputCountBefore": checked, "verifiedInputCountAfter": after, "afterVerifyError": after_error,
        "proxyRssPeak": max((sample["proxyRss"] for sample in samples), default=0),
        "treeRssPeak": max((sample["treeRss"] for sample in samples), default=0),
        "diskPeak": max((sample["diskBytes"] for sample in samples), default=0), "optionalEnoentSkipped": skipped,
        "lingeringBeforeForcedCleanup": lingering, "forcedCleanupKills": cleanup_kills, "ownedPidsRemaining": left,
        "processOwnership": "private Windows Job assigned while Bun primary thread was suspended; descendants inherit; kill-on-close",
        "jobMembersBeforeHandleClose": job_remaining, "cleanupErrors": cleanup_errors,
        "physicalModelSubmissions": 0, "samples": samples}
    with result_path.open("x", encoding="utf-8") as destination:
        json.dump(result, destination, indent=2)
        destination.write("\n")
    print(json.dumps({key: value for key, value in result.items() if key not in ("samples", "args")}))
    return 0 if passed else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-reviewed", action="store_true")
    parser.add_argument("--run", type=int, default=1)
    parser.add_argument("--case", choices=("all", "shutdown"), default="all")
    options = parser.parse_args()
    assert options.run > 0
    if options.execute_reviewed:
        raise SystemExit(run(options.run, options.case))
    frozen, count = verify()
    print(json.dumps({"status": "verified_only_no_browser_started", "head": frozen["sourceCommit"], "inputCount": count,
                      "manifestSha256": sha(MANIFEST), "supervisorSha256": sha(__file__)}))
