/**
 * 本地图片上传扩展
 *
 * /img            打开系统文件选择器选图，按配置自动上传（输入框上方显示缩略图条）
 * /img panel      打开小面板：预览 / 上传 / 删除 / 重试
 * /img clear      清空
 * /img config     查看当前上传配置
 * 拖拽图片到终端（终端会粘贴路径）自动加入
 * 快捷键 alt+i    打开小面板
 *
 * 配置：~/.pi/agent/image-upload.json（可用 PI_IMAGE_UPLOAD_CONFIG 指定文件）
 * 无任何硬编码密钥；token 只从配置或环境变量读取。
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Image, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface Cfg {
	endpoint: string;
	method: string;
	field: string;
	headers: Record<string, string>;
	token: string;
	tokenHeader: string;
	tokenPrefix: string;
	extraFields: Record<string, string | number>;
	multiple: boolean;
	autoUpload: boolean;
	maxSizeMB: number;
	accept: string[];
	responsePath: string;
	pasteResult: boolean;
}

interface Item {
	id: string;
	path: string;
	name: string;
	size: number;
	mime: string;
	data: Buffer;
	status: "ready" | "uploading" | "done" | "error";
	progress: number;
	url?: string;
	error?: string;
}

const WIDGET_KEY = "image-upload";
const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
const DEFAULTS: Cfg = {
	endpoint: "",
	method: "POST",
	field: "file",
	headers: {},
	token: "",
	tokenHeader: "Authorization",
	tokenPrefix: "Bearer ",
	extraFields: {},
	multiple: true,
	autoUpload: true,
	maxSizeMB: 10,
	accept: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
	responsePath: "",
	pasteResult: true,
};

let items: Item[] = [];
let widgetCtx: ExtensionContext | null = null;
let activeTui: { requestRender(): void } | null = null;
const previewCache = new Map<string, Image>();

// ---------- 配置 ----------
function loadCfg(): Cfg {
	let fileCfg: Partial<Cfg> = {};
	const file = process.env.PI_IMAGE_UPLOAD_CONFIG || path.join(getAgentDir(), "image-upload.json");
	try {
		if (fs.existsSync(file)) fileCfg = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Cfg>;
	} catch {
		fileCfg = {};
	}
	const cfg: Cfg = { ...DEFAULTS, ...fileCfg };
	// 环境变量优先，便于不落盘传密钥
	if (process.env.PI_IMAGE_UPLOAD_URL) cfg.endpoint = process.env.PI_IMAGE_UPLOAD_URL;
	if (process.env.PI_IMAGE_UPLOAD_TOKEN) cfg.token = process.env.PI_IMAGE_UPLOAD_TOKEN;
	if (process.env.PI_IMAGE_UPLOAD_FIELD) cfg.field = process.env.PI_IMAGE_UPLOAD_FIELD;
	cfg.accept = cfg.accept.map((x) => x.toLowerCase().replace(/^\./, ""));
	return cfg;
}

function extOf(p: string): string {
	return path.extname(p).slice(1).toLowerCase();
}

function validate(p: string, cfg: Cfg): string | null {
	if (!fs.existsSync(p)) return "文件不存在";
	if (!fs.statSync(p).isFile()) return "不是文件";
	if (!cfg.accept.includes(extOf(p))) return `类型不支持（允许 ${cfg.accept.join("/")}）`;
	if (fs.statSync(p).size > cfg.maxSizeMB * 1024 * 1024) return `超过 ${cfg.maxSizeMB}MB`;
	return null;
}

function fmtSize(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ---------- 缩略图条（输入框上方） ----------
function strip(theme: ExtensionContext["ui"]["theme"]): string {
	const parts = items.map((it) => {
		const name = truncateToWidth(it.name, 18);
		let tag: string;
		if (it.status === "uploading") tag = theme.fg("accent", `${Math.round(it.progress * 100)}%`);
		else if (it.status === "done") tag = theme.fg("success", "✓");
		else if (it.status === "error") tag = theme.fg("error", "✗");
		else tag = theme.fg("dim", "待传");
		return `${theme.fg("muted", "🖼")} ${name} ${theme.fg("dim", fmtSize(it.size))} ${tag}`;
	});
	return parts.join(theme.fg("dim", "  │  "));
}

function syncWidget(): void {
	if (!widgetCtx) return;
	if (!items.length) {
		widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	widgetCtx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			return { render: (w: number) => [truncateToWidth(strip(theme), w)], invalidate: () => {} };
		},
		{ placement: "aboveEditor" },
	);
}

function refresh(): void {
	syncWidget();
	activeTui?.requestRender();
}

function addPaths(paths: string[], ctx: ExtensionContext): number {
	const cfg = loadCfg();
	let added = 0;
	for (const p of paths) {
		if (!cfg.multiple && items.length >= 1) {
			ctx.ui.notify("已配置为单图模式", "warning");
			break;
		}
		const err = validate(p, cfg);
		if (err) {
			ctx.ui.notify(`${path.basename(p)}：${err}`, "warning");
			continue;
		}
		if (items.some((i) => i.path === p)) continue;
		try {
			const data = fs.readFileSync(p);
			items.push({
				id: randomBytes(6).toString("hex"),
				path: p,
				name: path.basename(p),
				size: data.length,
				mime: MIME[extOf(p)] ?? "application/octet-stream",
				data,
				status: "ready",
				progress: 0,
			});
			added++;
		} catch {
			ctx.ui.notify(`读取失败：${path.basename(p)}`, "error");
		}
	}
	if (added) refresh();
	return added;
}

// ---------- 系统文件选择器 ----------
async function pickImages(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[]> {
	try {
		if (process.platform === "win32") {
			const script =
				"Add-Type -AssemblyName System.Windows.Forms;" +
				"$d=New-Object System.Windows.Forms.OpenFileDialog;" +
				"$d.Multiselect=$true;" +
				"$d.Filter='Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp';" +
				"if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileNames|ForEach-Object{Write-Output $_}}";
			const r = await pi.exec("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000 });
			return splitPaths(r.stdout);
		}
		if (process.platform === "darwin") {
			const r = await pi.exec(
				"osascript",
				[
					"-e", 'set out to ""',
					"-e", 'set fs to choose file of type {"png","jpg","jpeg","gif","webp","bmp"} with prompt "选择图片" with multiple selections allowed',
					"-e", "repeat with f in fs",
					"-e", "set out to out & POSIX path of f & linefeed",
					"-e", "end repeat",
					"-e", "return out",
				],
				{ timeout: 120000 },
			);
			return splitPaths(r.stdout);
		}
		const r = await pi.exec(
			"zenity",
			["--file-selection", "--multiple", "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.bmp"],
			{ timeout: 120000 },
		);
		return splitPaths(r.stdout.replace(/\|/g, "\n"));
	} catch {
		// 无原生选择器时退回手输路径
		const input = await ctx.ui.input("图片路径（多个用换行或分号分隔）");
		return input ? splitPaths(input.replace(/;/g, "\n")) : [];
	}
}

function splitPaths(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
}

// ---------- 上传 ----------
function extractUrl(body: string, cfg: Cfg): string {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return body.trim().slice(0, 500);
	}
	const pick = (p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), json);
	if (cfg.responsePath) {
		const v = pick(cfg.responsePath);
		if (v == null) throw new Error(`返回中找不到 ${cfg.responsePath}`);
		return typeof v === "string" ? v : JSON.stringify(v);
	}
	for (const p of ["url", "data.url", "result.url", "data", "result"]) {
		const v = pick(p);
		if (typeof v === "string") return v;
	}
	return JSON.stringify(json).slice(0, 500);
}

function uploadItem(item: Item, cfg: Cfg, onProgress: (p: number) => void): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!cfg.endpoint) return reject(new Error("未配置上传地址"));
		let url: URL;
		try {
			url = new URL(cfg.endpoint);
		} catch {
			return reject(new Error("上传地址无效"));
		}

		const boundary = `----piimg${randomBytes(8).toString("hex")}`;
		const parts: Buffer[] = [];
		for (const [k, v] of Object.entries(cfg.extraFields)) {
			parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
		}
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${cfg.field}"; filename="${item.name}"\r\nContent-Type: ${item.mime}\r\n\r\n`,
			),
		);
		const pre = Buffer.concat(parts);
		const post = Buffer.from(`\r\n--${boundary}--\r\n`);
		const total = pre.length + item.data.length + post.length;

		const headers: Record<string, string | number> = {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": total,
			...cfg.headers,
		};
		if (cfg.token) headers[cfg.tokenHeader] = cfg.tokenPrefix + cfg.token;

		const transport = url.protocol === "https:" ? https : http;
		const req = transport.request(url, { method: cfg.method || "POST", headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(Buffer.from(c)));
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				const code = res.statusCode ?? 0;
				if (code < 200 || code >= 300) return reject(new Error(`HTTP ${code}: ${body.slice(0, 200)}`));
				try {
					resolve(extractUrl(body, cfg));
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(120000, () => req.destroy(new Error("上传超时")));

		// 分块写入，按字节上报进度
		let written = 0;
		const write = (buf: Buffer): boolean => {
			written += buf.length;
			onProgress(Math.min(1, written / total));
			return req.write(buf);
		};
		const drain = () => new Promise<void>((r) => req.once("drain", () => r()));
		void (async () => {
			try {
				if (!write(pre)) await drain();
				const STEP = 64 * 1024;
				for (let off = 0; off < item.data.length; off += STEP) {
					if (!write(item.data.subarray(off, off + STEP))) await drain();
				}
				if (!write(post)) await drain();
				req.end();
			} catch (e) {
				req.destroy(e instanceof Error ? e : new Error(String(e)));
			}
		})();
	});
}

async function uploadPending(ctx: ExtensionContext): Promise<void> {
	const cfg = loadCfg();
	const targets = items.filter((i) => i.status === "ready" || i.status === "error");
	if (!targets.length) {
		ctx.ui.notify("没有待上传图片", "info");
		return;
	}
	for (const item of targets) {
		item.status = "uploading";
		item.progress = 0;
		item.error = undefined;
		refresh();
		try {
			const url = await uploadItem(item, cfg, (p) => {
				item.progress = p;
				activeTui?.requestRender();
			});
			item.status = "done";
			item.progress = 1;
			item.url = url;
			if (cfg.pasteResult && url) ctx.ui.pasteToEditor(url);
			ctx.ui.notify(`上传成功：${item.name}`, "info");
		} catch (e) {
			item.status = "error";
			item.error = e instanceof Error ? e.message : String(e);
			ctx.ui.notify(`上传失败：${item.name} - ${item.error}`, "error");
		}
		refresh();
	}
}

// ---------- 小面板 ----------
function makePreview(item: Item, theme: ExtensionContext["ui"]["theme"], width: number): string[] {
	let img = previewCache.get(item.id);
	if (!img) {
		img = new Image(
			item.data.toString("base64"),
			item.mime,
			{ fallbackColor: (s: string) => theme.fg("dim", s) },
			{ maxWidthCells: Math.max(8, Math.min(width - 4, 36)), maxHeightCells: 8, filename: item.name },
		);
		previewCache.set(item.id, img);
	}
	return img.render(Math.max(8, width - 4)).map((l) => (l ? `  ${l}` : l));
}

function openPanel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return Promise.resolve();
	if (!items.length) {
		ctx.ui.notify("没有图片，先 /img 选择", "warning");
		return Promise.resolve();
	}
	return ctx.ui
		.custom<void>(
			(tui, theme, _kb, done) => {
				activeTui = tui;
				let sel = 0;
				return {
					render(width: number): string[] {
						if (sel > items.length - 1) sel = Math.max(0, items.length - 1);
						const out: string[] = [truncateToWidth(theme.fg("accent", theme.bold(`图片上传 (${items.length})`)), width)];
						const visible = 6;
						const start = Math.max(0, Math.min(sel - 2, items.length - visible));
						for (let i = start; i < Math.min(items.length, start + visible); i++) {
							const it = items[i];
							const cursor = i === sel ? theme.fg("accent", "> ") : "  ";
							let status: string;
							if (it.status === "uploading") {
								const n = Math.round(it.progress * 10);
								status = theme.fg("accent", `${"█".repeat(n)}${"░".repeat(10 - n)} ${Math.round(it.progress * 100)}%`);
							} else if (it.status === "done") status = theme.fg("success", "✓ ") + theme.fg("dim", it.url ?? "");
							else if (it.status === "error") status = theme.fg("error", `✗ ${it.error ?? ""}`);
							else status = theme.fg("dim", "待上传");
							const line = `${cursor}${truncateToWidth(it.name, 20)}  ${theme.fg("dim", fmtSize(it.size))}  ${status}`;
							out.push(truncateToWidth(line, width));
						}
						if (items[sel]) out.push(...makePreview(items[sel], theme, width));
						out.push(
							truncateToWidth(
								theme.fg("dim", "a 添加 · u/enter 上传 · d 删除 · r 重试 · esc 关闭"),
								width,
							),
						);
						return out;
					},
					invalidate() {},
					handleInput(data: string): void {
						if (data === "q" || matchesKey(data, "escape")) return done();
						if (matchesKey(data, "up") || data === "k") sel = Math.max(0, sel - 1);
						else if (matchesKey(data, "down") || data === "j") sel = Math.min(items.length - 1, sel + 1);
						else if (data === "a") void pickAndAdd().then(() => tui.requestRender());
						else if (data === "u" || matchesKey(data, "enter")) void uploadPending(ctx);
						else if (data === "d" || matchesKey(data, "delete") || matchesKey(data, "backspace")) {
							if (items[sel]) {
								previewCache.delete(items[sel].id);
								items.splice(sel, 1);
								refresh();
							}
						} else if (data === "r") {
							const it = items[sel];
							if (it && it.status === "error") {
								it.status = "ready";
								void uploadPending(ctx);
							}
						}
						tui.requestRender();
					},
				};

				async function pickAndAdd(): Promise<void> {
					const paths = await pickImages(pi, ctx);
					if (paths.length) addPaths(paths, ctx);
				}
			},
			{ overlay: true, overlayOptions: { anchor: "top-center", width: 64, maxHeight: "60%", margin: 1 } },
		)
		.finally(() => {
			activeTui = null;
		});
}

// ---------- 拖拽（终端粘贴路径）识别 ----------
function parseDropped(text: string, cfg: Cfg): string[] {
	const lines = splitPaths(text);
	if (!lines.length) return [];
	if (!lines.every((p) => fs.existsSync(p) && cfg.accept.includes(extOf(p)))) return [];
	return cfg.multiple ? lines : lines.slice(0, 1);
}

// ---------- 注册 ----------
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		widgetCtx = ctx;
		syncWidget();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetCtx = null;
		activeTui = null;
	});

	pi.on("input", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") return;
		const cfg = loadCfg();
		const paths = parseDropped(event.text, cfg);
		if (!paths.length) return;
		if (addPaths(paths, ctx) && cfg.autoUpload) void uploadPending(ctx);
		return { action: "handled" };
	});

	pi.registerCommand("img", {
		description: "选择/上传本地图片（/img panel 打开面板）",
		getArgumentCompletions: (prefix) =>
			["panel", "clear", "config"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "clear" || a === "c") {
				items = [];
				previewCache.clear();
				refresh();
				ctx.ui.notify("已清空", "info");
				return;
			}
			if (a === "config" || a === "cfg") {
				const c = loadCfg();
				ctx.ui.notify(
					c.endpoint ? `上传地址：${c.endpoint}（${c.token ? "已配置 token" : "无 token"}）` : "未配置上传地址：~/.pi/agent/image-upload.json",
					c.endpoint ? "info" : "warning",
				);
				return;
			}
			if (a === "panel" || a === "p") {
				await openPanel(pi, ctx);
				return;
			}
			const paths = await pickImages(pi, ctx);
			if (!paths.length) {
				ctx.ui.notify("未选择图片", "info");
				return;
			}
			if (addPaths(paths, ctx) && loadCfg().autoUpload) await uploadPending(ctx);
		},
	});

	pi.registerShortcut("alt+i", {
		description: "图片上传面板",
		handler: async (ctx) => {
			await openPanel(pi, ctx);
		},
	});
}
