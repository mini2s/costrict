# 重构 csCloudService.ts 以及相关的逻辑

### 需求：保证用户启动插件不会因为无 cs-cloud 而阻塞 (插件运行的环境有 很多种，比如：mac、windows、linux、docker、remote-ssh 等)

- 1.检查 `$HOME/.costrict/cs-cloud/server_url` 文件是否存在（存在说明，cs-cloud 已经运行），如果存在，则直接使用该地址，否则使用默认地址，如果不存在进入下一步检查
- 2.检查 `$HOME/.costrict/cs-cloud/bin` 存在 `cs-cloud` 或 `cs-cloud.exe`，如果存在，说明，`cs-cloud` 已经安装，直接启动，然后获取 `server_url`，否则进入下一步检查
- 3.检查 全局是否存在 csc，如果存在，执行 `csc cloud status`，然后获取 `server_url`，否则进入下一步
- 4.使用提示页面告知用户没有下载 `csc`，并给出下载 方案 `npm install -g @costrict/csc`
- 5.在运行过程中如果检测到本地的 `server_url` 文件没了（代表 cs-cloud 停止了，需要提示用户重新启动）、如果 `server_url` 还有，但是 与之前的 不一样，需要更新本地的连接地址

# $HOME/.costrict/cs-cloud/server_url 文件记录了当前使用的地址

```
http://127.0.0.1:59249
```

# 通过 cs-cloud 或 cs-cloud.exe 执行 cs-cloud status 命令，查看当前状态会得到如下输出：

`$HOME/.costrict/cs-cloud/bin 存在 cs-cloud 或 cs-cloud.exe`

```shell
status

  ✓ Running

Developer info
  pid: 658756
  mode: cloud
  root: /home/mini/.costrict/cs-cloud
  cloud_url: https://zgsm.sangfor.com/cloud-api
  auth: true
  user: phone/ph_17701200314
  device: true
  device_id: 842842c2fae5dae527c8b4ba31bb38ce1f6c2ba0e90b86d555345fbe38ef34cd
  device_id.platform: linux
  device_id.mac: 02422cfebcb6
  device_id.username: mini
  local_url: http://127.0.0.1:59249
  logs: /home/mini/.costrict/cs-cloud/app.log

Agent runtimes
  agent: csc [default] healthy
  latency: 4ms

→ Cloud dashboard
  https://zgsm.sangfor.com/cloud
```
