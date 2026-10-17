本次只读独审通过源码修正：新 TCP 探针只接受 ECONNREFUSED，CONNECTED 继续等待，超时和其他错误失败；探针与断言位于真实 child close 之后、finally 显式 server.stop 之前，原 catch-all 已移除。

这解决了先前指出的停机证据分类缺口，未发现新增假绿路径或断言弱化。但尚未复测，不能把 run1 结果算作新探针已运行。原审阅和原始运行证据均保留；本轮未运行测试、Chrome、CLI 或 HTTP。
