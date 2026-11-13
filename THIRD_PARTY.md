# 第三方组件与素材

- AutoHotkey 2.0.30 从官方 GitHub Release 下载并校验，遵循其随附许可；不重新打包该解释器。
- Python 依赖由 pip 安装，按各自发行包许可使用。
- `static-assets/extracted` 与 `templates` 内保留的按钮、数字、牌面和结算字形来自游戏客户端或界面局部素材，权利归原权利人；不包含个人昵称图或完整玩家截图。
- `patch-tiles.py` 从使用者本地安装生成编码牌面，完整资源及备份不分发。
- 听风 v96-hp、听元 v10 仅分发 Windows x64／ARM64 可执行文件，不包含其引擎源码。相关编译信息及校验值在 `bin`。
- ARM64 引擎及 WGC 采集 DLL 使用 LLVM-MinGW 静态运行库；许可见 `licenses/llvm-mingw`。x64 引擎保留 GCC 正式构建，运行库适用 GCC Runtime Library Exception；许可见 `licenses/gcc`。
- 引擎使用的 nlohmann/json 的 MIT 许可见 `licenses/nlohmann/LICENSE.MIT`。

未额外指定项目整体开源许可证；公开访问不改变第三方素材、组件及引擎的权利。
