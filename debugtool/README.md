# debugtool — 实时调试观测台

跑着的程序里正在发生什么：调用栈、数据结构、变量。不停程序。

> 设计见 [DESIGN.md](./DESIGN.md)。这里是"怎么用/现在到哪一步"。

## 现在能做什么（M0）

- `src/debugtool/` 里的三块纯逻辑已经可用且有测试：协议（NDJSON v1）、安全序列化（深度/宽度/循环/脱敏/不调用 getter）、采样聚合（热栈 + 卡顿窗口）。
- **注入通道已打通并实测**：一个普通 Python 程序，只加 `PYTHONPATH` 和两个环境变量，就会把主线程的栈以 10 Hz 推到本机 socket；程序自己的 stdout 完全不受影响。

还没做（M1 起）：`/debug` 页面、快照与监视的 agent 侧、JS/Go agent。见 DESIGN.md 第九节。

## 自己验一遍

```bash
# 纯逻辑 + 真实进程（约 3 秒）
npm run verify:debugtool
```

看单条通道是否通（不经过套件）：

```bash
# 1. 起一个监听端（随便什么能收 TCP 的都行，这里用 node）
node -e "require('net').createServer(s=>{s.setEncoding('utf8');s.on('data',d=>process.stdout.write(d))}).listen(7391,'127.0.0.1',()=>console.log('listening'))"

# 2. 另开一个终端，用探针注入示例程序
cd debugtool/samples/py
PYTHONPATH=../../probes NLG_DEBUG_PORT=7391 NLG_DEBUG_TOKEN=dev NLG_DEBUG_HZ=10 python -u app.py
```

第一行应该是 `hello`，之后每 100 ms 一行 `stack`，里面能看到 `main > work > step` 这样的帧。

## 目录

```
debugtool/
  DESIGN.md                     方案（含协议、限额、里程碑、风险）
  README.md                     本文件
  samples/py/app.py             示例目标：嵌套调用 + sleep + 循环引用 + 密钥字段
  probes/nlg_agent_probe.py     M0 探针 agent（栈采样）
  probes/sitecustomize.py       注入点（解释器启动即执行）
src/debugtool/                  引擎（要进 exe，所以放在 src 内）
  protocol.ts                   线上格式 + 校验
  serializer.ts                 安全序列化
  sampler.ts                    热栈 / 卡顿
scripts/verify-debugtool.ts     套件
```

## 三条硬规则（改动前先读）

1. **观测不能拖慢或搞崩被测程序**：agent 里任何异常都必须吞掉；采样率与深度都有上限。
2. **不执行用户代码**：序列化只读数据描述符，`__repr__`/`toString`/getter 一律不调；只有用户手动添加的监视表达式才求值。
3. **省略必须可见**：截断要说原因（depth/size/unsupported/redacted），并给出被省略的数量。
