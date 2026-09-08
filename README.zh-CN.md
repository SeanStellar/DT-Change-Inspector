# 双时相变化检查工具

一款用于双时相遥感影像变化检查的桌面工具，支持交互式查看、多颜色 Mask 标注以及 AI 辅助圈选，全部离线运行。

## 功能

- **双时相对比查看**：左右分屏对比 A/B 两期影像，支持闪烁、平移、缩放。
- **彩色多边形标注**：支持 0-255 共 256 个标签，每个标签可自定义颜色和快捷键。
- **AI 圈选**：内置 MobileSAM ONNX 模型，本机离线运行，点击目标区域自动出轮廓。
- **连通区域删除**：按颜色快速删除同类标注区域。
- **Mask 导出**：标注结果保存为黑底 RGB Mask 图片。

## 环境要求

- Windows 10 / 11 (x64)

## 快速开始

### 普通用户

从 [Releases](../../releases) 页面下载最新安装包，双击运行，按向导完成安装。

### 开发者

```bash
# Node 依赖（Electron 客户端）
pnpm install

# Python 依赖（mask_core.py / pair_change_viewer.py）
pip install -r requirements.txt

# 启动 Electron 应用
pnpm start
```

### 构建

```bash
# 构建 Windows NSIS 安装包
pnpm build

# 输出目录：release/
```

### 测试

```bash
# Electron 单元测试
pnpm test

# 冒烟测试
pnpm test:smoke
```

## 快捷键

| 按键 | 功能 |
|------|------|
| A / ← | 上一张 |
| D / → | 下一张 |
| 空格 / Tab | 切换前后时相 |
| B | 闪烁 A/B |
| V | 左右对比 |
| X | 互换 A/B 文件 |
| S | 显示/隐藏 Mask |
| C | 标签管理器 |
| Q | 彩色多边形标注 |
| E | 删除标注 |
| F | AI 圈选 |
| Delete | 移动到 deleted_pairs |
| Shift+Delete | 彻底删除 |
| U / Ctrl+Z | 撤销删除 |
| R / 0 | 重置视图 |
| + / - / 滚轮 | 缩放 |
| 中键拖动 | 平移 |
| Enter | 确认标注 |
| Backspace | 撤回上一个点 |
| Esc | 取消当前操作 |

## Mask 格式说明

- 标签颜色直接以 RGB 值写入 Mask 文件。
- 未标注背景始终为纯黑 `(0, 0, 0)`。
- 界面上的红色轮廓仅用于查看，不会写入 Mask 文件。
- 标签信息保存在程序旁的 `mask_labels.json`；若安装目录无写入权限，会安全回退到用户配置目录。

## 许可证

MIT License - 详见 [LICENSE](LICENSE)。
