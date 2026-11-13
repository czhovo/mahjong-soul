# 听风执牌 v7 · Mahjong Soul

Windows 雀魂图像识别与自动操作程序。识别可见局面，累进维护公开事件和本方手牌，将局面交给决策引擎，执行并核对动作。支持四人场与三人场、两阶段吃碰、鸣牌等待推断、立直后自动和牌，以及终局自动继续流程。

四人场使用听风 v96-hp，三人场使用听元 v10。仓库仅包含这两个引擎的 **Windows x64／ARM64 编译结果，不包含引擎源码**；各引擎有 5.5／3.5／2.2 秒三档。`wgc-capture.cpp` 是执牌端的窗口采集实现。

本公开版移除了启动识别样本校验、引擎搜索预热及点击自测。没有自检图片、个人游戏截图或预置个人昵称；不识别昵称或头像，不保存和牌／终局图片，也不输出本方和牌、整场排名和 PT 结算信息。功能所需的纯按钮、数字、字形和牌面模板保留。

## 安装与启动

准备 Windows 10 1903 或更新系统、Node.js 22+、Windows x64 Python 3.12 和 Steam 版雀魂。在项目目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

随后按 [配置说明](docs/配置说明.md) 设置编码牌面，再启动：

```powershell
node resident.mjs -g
```

`-b/-s/-g/-t` 分别选择铜／银／金／玉之间，四者互斥。`-3/-4` 选择人数，默认四人；`-l` 全程 2.2 秒；`-f` 跳过开局点击，终局流程正常进行。没有场次参数时必须带 `-f`。参数顺序可以交换。

## 采集和分发

采集使用 Windows Graphics Capture，通过窗口句柄获取窗口自身画面；遮挡或移动不改变采集目标。保留原始像素与 v7 坐标口径，使用共享内存传递，默认不归档全部采集帧。执行点击仍按原有流程激活游戏窗口。最小化后需要恢复窗口。

`bin/windows-x64`、`bin/windows-arm64` 保存决策引擎；`bin/capture/windows-x64` 保存供 x64 Python 加载的 WGC DLL。安装脚本选择引擎架构并复制运行文件；Windows ARM64 上也使用 x64 Python 和 AutoHotkey64，配套原生 ARM64 决策引擎。ARM64 尚未实机运行验证。

[下载引擎与校验文件](https://github.com/czhovo/mahjong-soul/releases/tag/v7-20261114-clean)。Source code ZIP 包含完整执牌端和两个架构的编译结果。

- [配置说明](docs/配置说明.md)：依赖、牌面切换和参数。
- [决策侧接口](docs/决策侧接口.md)：JSON Lines、两阶段鸣牌和搜索统计。
- [验证与隐私范围](VALIDATION.md)：发布检查与历史清理说明。
- [第三方组件](THIRD_PARTY.md)：运行库和素材来源。
