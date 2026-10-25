import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexInterruptHookCommand } from "../src/codex-interrupt-hook";
test("Native trust key uses loaded layer path, never yadm symlink target",()=>{
 const dir=mkdtempSync(join(tmpdir(),"r42-hook-"));
 try {
  const source=join(dir,"config.toml##class.test"), logical=join(dir,"config.toml");
  writeFileSync(source,"");symlinkSync(source,logical);
  const r=installCodexInterruptHookCommand("",logical,"true");
  expect(r.text).toContain(`${logical}:interrupt:0:0`);
  expect(r.text).not.toContain(`${source}:interrupt:0:0`);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
