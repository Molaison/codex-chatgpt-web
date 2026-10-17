本轮非作者补充复核通过：run2 只执行 shutdown，原始日志为 1 pass、3 filtered、0 fail、17 断言；255 项冻结输入独立复算全部一致，Bun31944正常退出，Job 无强杀、无残留。

现有证据形成明确顺序：真实 Chrome37000 活着时 health 为 draining/HTTP0/browser1 且 shutdown409；随后真实 close 已观察到、PID不活；在 finally f.close 的显式 server.stop 前，fresh TCP 得到 ECONNREFUSED/refused=true，专门 note 原样记录。这补足了原 run1 的“可能只是 health 异常、清理后才关端口”证据缺口。最终清理后的端口拒绝另有记录，没有与此前证据混用。

本报告不覆盖或改写 run1 的有限证据判定；前三类未重新执行。仍仅为受控本地 Chrome/生产 DOM循环与代理生命周期验收，准备、选模、提交、绑定及 worker 由替身承担，不是真实 ChatGPT、认证、模型、helper/end 或 OS信号验收。审阅过程未运行任何测试、Chrome、CLI或HTTP。
