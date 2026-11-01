# 第三方组件与素材

- AutoHotkey v2：从 [官方发布页](https://github.com/AutoHotkey/AutoHotkey/releases/tag/v2.0.30) 下载原始 ZIP，按其附带许可使用；仓库不重新打包该解释器。
- Python 依赖：NumPy、OpenCV、Pillow、lz4、RapidOCR、ONNX Runtime、UnityPy 由 pip 安装，各自许可随发行包提供。
- `static-assets/extracted` 中的按钮、计数、牌面及结算字形来自雀魂客户端，用于识别匹配；`templates` 和启动自检图片包含游戏界面的局部素材。这些游戏素材权利归原权利人，不因放入仓库而变更。
- `patch-tiles.py` 从用户本地安装的游戏资源生成编码牌面，完整游戏资源包及其备份不随仓库分发。
- 听风 v70 的两个可执行文件单独发布于 Release；仓库不含其 C++ 源码。

本次发布未额外指定项目整体的开源许可证；公开可访问不等于第三方素材或引擎获得无限制再授权。
