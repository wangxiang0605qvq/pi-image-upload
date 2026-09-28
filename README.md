# pi-image-upload

pi 扩展：本地图片选择/上传，输入框上方显示缩略图条。

- `/img`：打开文件选择器选图，按配置自动上传
- `/img panel`：小面板（预览 / 上传 / 删除 / 重试）
- `/img clear`：清空
- `/img config`：查看当前配置
- 快捷键 `alt+i`：打开面板
- 拖拽图片到终端自动加入

## 安装

### 方式一：作为 pi 包安装（推荐）

```bash
pi install git:github.com/wangxiang0605qvq/pi-image-upload
```

### 方式二：手动复制

```bash
cp image-upload.ts ~/.pi/agent/extensions/image-upload.ts
cp image-upload.json.example ~/.pi/agent/image-upload.json   # 再按需修改
```

配置：`~/.pi/agent/image-upload.json`（可用环境变量 `PI_IMAGE_UPLOAD_CONFIG` 指定其他文件）。
无任何硬编码密钥；token 只从配置或环境变量读取。

然后 `/reload`。
