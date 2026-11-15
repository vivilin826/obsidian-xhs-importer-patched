/*
 * Xiaohongshu Importer (Patched)
 * Original author: bnchiang96 (MIT) — https://github.com/bnchiang96/xiaohongshu-importer
 * Patched build: v1.2.0 by vivilin826
 *
 * 改动要点（针对 2026 年小红书分享页改版）：
 *  1. 用 iPhone UA 访问 discovery/item + xsec_source=app_share，不跳登录、无需 Cookie
 *  2. 主解析路径改为 noteData.data.noteData，保留 noteDetailMap / og 兜底
 *  3. 图片取 infoList 的 H5_DTL（1080 大图），http 自动升 https
 *  4. 视频 h264 → h265 → av1 → originVideoKey 逐级兜底，下载带 Referer
 *  5. 下载通道：requestUrl 失败自动切 Node https 流式下载
 *  6. 链接过期（跳 /404/）时明确报错，不生成空笔记
 */

var F = Object.defineProperty;
var j = Object.getOwnPropertyDescriptor;
var A = Object.getOwnPropertyNames;
var X = Object.prototype.hasOwnProperty;
var R = (u, g) => {
	for (var t in g) F(u, t, { get: g[t], enumerable: !0 });
};
var H = (u, g, t, s) => {
	if ((g && typeof g == "object") || typeof g == "function")
		for (let e of A(g)) !X.call(u, e) && e !== t && F(u, e, { get: () => g[e], enumerable: !(s = j(g, e)) || s.enumerable });
	return u;
};
var B = (u) => H(F({}, "__esModule", { value: !0 }), u);
var P = {};
R(P, { default: () => XiaohongshuImporter });
module.exports = B(P);

var ob = require("obsidian");

/* 关键：必须用手机 UA 访问，桌面 UA 会被强制跳登录页 */
const UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const DEFAULT_SETTINGS = {
	defaultFolder: "XHS Notes",
	categories: ["美食", "旅行", "娱乐", "知识", "工作", "情感", "个人成长", "优惠", "搞笑", "育儿"],
	lastCategory: "",
	downloadMedia: !1,
	cookie: "",
	downloadVideo: !0,
	debug: !1,
};

/* ---------------- 工具函数 ---------------- */

function cleanUrl(raw) {
	return raw
		.replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
		.replace(/[.,，。;；!！?？、)\]}>）】》」』]+$/u, "");
}

function buildHeaders(cookie) {
	const h = {
		"User-Agent": UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		Referer: "https://www.xiaohongshu.com/",
	};
	if (cookie && cookie.trim()) h.Cookie = cookie.trim();
	return h;
}

function noteIdFromUrl(url) {
	const m = url.match(/\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/);
	return m ? m[1] : null;
}

/* 从 HTML 中做括号配对，取出 __INITIAL_STATE__ 的完整 JSON（比正则到 </script> 更稳） */
function extractBalancedJson(text, startIdx) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = startIdx; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(startIdx, i + 1);
		}
	}
	return null;
}

function parseInitialState(html) {
	const anchor = html.indexOf("window.__INITIAL_STATE__");
	if (anchor < 0) return null;
	const brace = html.indexOf("{", anchor);
	if (brace < 0) return null;
	const raw = extractBalancedJson(html, brace);
	if (!raw) return null;
	try {
		// 小红书会在 JSON 里塞裸 undefined，换成 null；个别行内注释也去掉
		const fixed = raw.replace(/:\s*undefined(?=[,}\]])/g, ":null");
		return JSON.parse(fixed);
	} catch (e) {
		console.log("[XHS] __INITIAL_STATE__ 解析失败：", e.message);
		return null;
	}
}

function metaContent(html, property) {
	const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, "i");
	const m = html.match(re);
	return m ? m[1] : null;
}

function decodeEntities(s) {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function stripHashTags(text) {
	return text
		.replace(/\[话题\]#?/g, "")
		.replace(/\[[^\]]{1,8}\]#?/g, "")
		.replace(/#[^#\s]{1,30}\[话题\]#?/g, "")
		.trim();
}

function cleanTitle(raw) {
	return decodeEntities(raw || "")
		.replace(/\s*[-–—|]\s*(小红书|rednote|Xiaohongshu)\s*$/i, "")
		.replace(/\s*[-–—|]\s*$/, "")
		.trim();
}

/* 去掉正文末尾整行都是话题标签的段落 */
function stripTrailingTags(text) {
	const lines = text.split("\n");
	while (lines.length) {
		const last = lines[lines.length - 1].trim();
		if (last === "" || (/^#/.test(last) && last.split(/\s+/).every((w) => w.startsWith("#"))) ) {
			lines.pop();
			continue;
		}
		break;
	}
	return lines.join("\n").trim();
}

function safeName(s, max = 80) {
	const cleaned = (s || "")
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	const out = cleaned || "Untitled";
	return out.slice(0, max);
}

/* ---------------- 插件主体 ---------------- */

var XiaohongshuImporter = class extends ob.Plugin {
	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("book", "Import Xiaohongshu note", async () => {
			const input = await this.promptForShareText();
			if (!input || !input.text) return;
			const url = this.extractURL(input.text);
			if (!url) return void new ob.Notice("没有识别到小红书链接，请粘贴 App 里的整段分享文字。");
			await this.importXHSNote(url, input.category, input.downloadMedia);
		});

		this.addCommand({
			id: "import",
			name: "Import Xiaohongshu note",
			callback: async () => {
				const input = await this.promptForShareText();
				if (!input || !input.text) return;
				const url = this.extractURL(input.text);
				if (!url) return void new ob.Notice("没有识别到小红书链接，请粘贴 App 里的整段分享文字。");
				await this.importXHSNote(url, input.category, input.downloadMedia);
			},
		});

		this.addSettingTab(new XiaohongshuSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async promptForShareText() {
		return new Promise((resolve) => {
			new ImportModal(this.app, this.settings, resolve).open();
		});
	}

	/* 支持 xhslink 短链 / explore / discovery 三种形式，保留 query（xsec_token 在里面） */
	extractURL(text) {
		const t = cleanUrl(text.trim());
		const patterns = [
			/https?:\/\/xhslink\.com\/[a-zA-Z0-9\/]+(?:\?[^\s,，]*)?/,
			/https?:\/\/xhslink\.cn\/[a-zA-Z0-9\/]+(?:\?[^\s,，]*)?/,
			/https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item|item)\/[0-9a-zA-Z]+(?:\?[^\s,，]*)?/,
		];
		for (const p of patterns) {
			const m = t.match(p);
			if (m) return m[0];
		}
		return null;
	}

	/* ---------- 抓取 ---------- */

	/* 把链接归一化成"移动端分享页"：必须带 xsec_token + xsec_source=app_share，否则会跳登录 */
	buildRequestUrl(url) {
		const id = noteIdFromUrl(url);
		if (!id) return url;
		const token = (url.match(/xsec_token=([^&]+)/) || [])[1];
		if (!token) return url;
		return `https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=${token}&xsec_source=app_share`;
	}

	async fetchPage(url) {
		const target = this.buildRequestUrl(url);
		const res = await ob.requestUrl({
			url: target,
			method: "GET",
			headers: buildHeaders(this.settings.cookie),
			throw: !1,
		});
		if (this.settings.debug) {
			console.log("[XHS] fetch", res.status, (res.text || "").length + "B", target, "落地判断:", (res.text || "").includes("noteData") ? "有数据" : "疑似登录页");
		}
		return { status: res.status, html: res.text || "", finalUrl: target };
	}

	/* ---------- 解析三层兜底 ---------- */

	getNote(html, noteId) {
		const state = parseInitialState(html);
		if (!state) return null;

		/* 主路径：移动端分享页的 noteData.data.noteData */
		const nd = state.noteData && state.noteData.data && state.noteData.data.noteData;
		if (nd && (nd.title || nd.desc || nd.imageList)) return nd;

		const map = state.note && state.note.noteDetailMap;
		if (!map) return null;

		if (noteId && map[noteId] && map[noteId].note) return map[noteId].note;

		for (const key of Object.keys(map)) {
			const entry = map[key];
			if (entry && entry.note && (entry.note.title || entry.note.desc || entry.note.imageList)) {
				return entry.note;
			}
		}
		return null;
	}

	/* 图片取最高清那张（H5_DTL 是 1080 大图） */
	imageUrls(note) {
		return (note.imageList || [])
			.map((img) => {
				const infos = img.infoList || [];
				const dtl = infos.find((i) => i.imageScene === "H5_DTL") || infos[0];
				const u = (dtl && dtl.url) || img.urlDefault || img.urlPre || img.url || "";
				return u ? u.replace(/^http:\/\//, "https://") : "";
			})
			.filter((u) => u.startsWith("http"));
	}

	parse(html, noteId) {
		const note = this.getNote(html, noteId);

		if (note) {
			return {
				ok: !0,
				title: cleanTitle((note.title || "").trim() || metaContent(html, "og:title") || "") || "无标题笔记",
				desc: note.desc || "",
				type: note.type === "video" ? "video" : "normal",
				images: this.imageUrls(note),
				video: this.videoUrlFromNote(note),
				author: (note.user && (note.user.nickname || note.user.nickName)) || "",
				tags: this.tagsFromNote(note),
				via: "initial-state",
			};
		}

		/* 兜底 A：og / meta */
		const ogTitle = metaContent(html, "og:title");
		const ogDesc = metaContent(html, "og:description");
		const ogImage = metaContent(html, "og:image");
		const ogVideo = metaContent(html, "og:video");

		let title = ogTitle || (html.match(/<title>(.*?)<\/title>/s) || [])[1] || "";
		title = cleanTitle(title);

		const descBox = html.match(/<div[^>]*id=["']detail-desc["'][^>]*>([\s\S]*?)<\/div>/i);
		const desc = descBox ? decodeEntities(descBox[1].replace(/<[^>]+>/g, "")) : decodeEntities(ogDesc || "");

		const imgs = [];
		if (ogImage) imgs.push(ogImage);
		const imgRe = /https?:\/\/sns-[a-z0-9\-]+\.xhscdn\.com\/[^\s"'\\<>)]+/g;
		(html.match(imgRe) || []).forEach((u) => {
			if (!/\.(mp4|m3u8)/i.test(u) && !imgs.includes(u)) imgs.push(u);
		});

		/* 兜底 B：直接从 HTML 里抠视频地址 */
		let video = null;
		const mv = html.match(/"masterUrl":"(http[^"]+\.mp4[^"]*)"/);
		if (mv) video = mv[1].replace(/\\u002F/g, "/");
		if (!video) {
			const ok = html.match(/"originVideoKey":"([^"]+)"/);
			if (ok) video = `https://sns-video-bd.xhscdn.com/${ok[1]}`;
		}
		if (!video && ogVideo) video = ogVideo;

		/* 落到 404 / 风控页 / 只有梗概标题，都算链接失效，不要生成空笔记 */
		const deadLink =
			/\/404\/|xhs_sec_server|sec_[A-Za-z0-9]{6,}/.test(html) ||
			/^小红书$/.test(title) ||
			/^小红书\s*-\s*你的生活兴趣社区$/.test(title);

		const hasContent = !!(desc || imgs.length) && !deadLink;
		return {
			ok: hasContent,
			title: title || "Untitled Xiaohongshu Note",
			desc,
			type: video ? "video" : "normal",
			images: imgs,
			video,
			author: "",
			tags: (desc.match(/#[^#\s\[\]]{1,30}/g) || []).map((s) => s.slice(1)),
			via: "meta-fallback",
		};
	}

	videoUrlFromNote(note) {
		const stream = note.video && note.video.media && note.video.media.stream;
		if (stream) {
			for (const codec of ["h264", "h265", "av1"]) {
				const arr = stream[codec];
				if (arr && arr.length && arr[0].masterUrl) return arr[0].masterUrl;
			}
		}
		const key = note.video && note.video.consumer && note.video.consumer.originVideoKey;
		if (key) return `https://sns-video-bd.xhscdn.com/${key}`;
		return null;
	}

	tagsFromNote(note) {
		const list = (note.tagList || []).map((t) => t.name).filter(Boolean);
		if (list.length) return list;
		return ((note.desc || "").match(/#[^#\s\[\]]{1,30}/g) || []).map((s) => s.slice(1));
	}

	/* ---------- 媒体下载（带 Referer，写二进制） ---------- */

	async ensureFolder(path) {
		const p = ob.normalizePath(path);
		if (!(await this.app.vault.adapter.exists(p))) {
			await this.app.vault.createFolder(p);
		}
	}

	/* 备用通道：绕开 Obsidian 的 requestUrl，直接用 Node 的 https/http 流式下载 */
	async downloadViaNode(url, headers) {
		const lib = url.startsWith("https:") ? require("https") : require("http");
		const fs = require("fs");
		const os = require("os");
		const pathMod = require("path");
		const tmp = pathMod.join(os.tmpdir(), `xhs-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);

		await new Promise((resolve, reject) => {
			const req = lib.get(url, { headers }, (res) => {
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}
				const ws = fs.createWriteStream(tmp);
				res.pipe(ws);
				ws.on("finish", () => resolve());
				ws.on("error", reject);
			});
			req.on("error", reject);
			req.setTimeout(90000, () => req.destroy(new Error("timeout 90s")));
		});

		const buf = fs.readFileSync(tmp);
		fs.unlinkSync(tmp);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}

	async downloadMedia(url, folder, filename) {
		const headers = { "User-Agent": UA, Referer: "https://www.xiaohongshu.com/", Accept: "*/*" };
		const attempts = [];
		const urls = url.startsWith("http://") ? [url.replace(/^http:/, "https:"), url] : [url];

		for (const u of urls) {
			try {
				const res = await ob.requestUrl({ url: u, method: "GET", headers, throw: !1 });
				if (res.status !== 200 || !res.arrayBuffer) throw new Error(`HTTP ${res.status}`);
				const path = ob.normalizePath(`${folder}/${filename}`);
				await this.app.vault.adapter.writeBinary(path, res.arrayBuffer);
				return filename;
			} catch (e) {
				attempts.push(`requestUrl(${u.slice(0, 40)}…) → ${e.message}`);
			}
		}

		for (const u of urls) {
			try {
				const ab = await this.downloadViaNode(u, headers);
				const path = ob.normalizePath(`${folder}/${filename}`);
				await this.app.vault.adapter.writeBinary(path, ab);
				return filename;
			} catch (e) {
				attempts.push(`node(${u.slice(0, 40)}…) → ${e.message}`);
			}
		}

		const err = new Error(attempts.join(" | "));
		err.url = url;
		throw err;
	}

	/* 把下载失败的原因落成日志，方便排查 */
	async logDownloadFailure(folder, lines) {
		try {
			const p = ob.normalizePath(`${folder}/_xhs-download-errors.log`);
			const prev = (await this.app.vault.adapter.exists(p))
				? await this.app.vault.adapter.read(p)
				: "";
			const body = `${prev}${new Date().toISOString()}\t${lines.join("\n\t")}\n`;
			await this.app.vault.adapter.write(p, body);
		} catch (e) {
			console.log("[XHS] 写日志失败", e);
		}
	}

	extFromContentType(headers, fallback) {
		const ct = (headers && (headers["content-type"] || headers["Content-Type"])) || "";
		if (/mp4/i.test(ct)) return "mp4";
		if (/webp/i.test(ct)) return "webp";
		if (/png/i.test(ct)) return "png";
		if (/gif/i.test(ct)) return "gif";
		if (/jpe?g/i.test(ct)) return "jpg";
		return fallback;
	}

	/* ---------- 主流程 ---------- */

	async importXHSNote(url, category, downloadMedia) {
		const notice = (msg, t) => new ob.Notice(msg, t);
		try {
			notice("正在抓取…", 3000);

			const { html, status } = await this.fetchPage(url);
			if (this.settings.debug) {
				console.log("[XHS] html head:", html.slice(0, 400));
			}

			const noteId = noteIdFromUrl(url);
			const data = this.parse(html, noteId);

			if (!data.ok) {
				const hint =
					status !== 200
						? `页面返回 HTTP ${status}`
						: /\/404\/|xhs_sec_server/.test(html)
						? "这条链接的 xsec_token 已过期（被转到了 404 页），请重新从 App 复制一条新的分享链接"
						: "页面里没有笔记数据，可能是笔记被删除/仅自己可见，请换一条链接试试";
				return void notice(`导入失败：${hint}`, 10000);
			}

			const base = this.settings.defaultFolder || "";
			const mediaFolder = base ? `${base}/media` : "media";
			const catFolder = category || "Uncategorized";
			const noteFolder = base ? `${base}/${catFolder}` : catFolder;
			const fileBase = safeName(data.title, 60) || "Untitled";
			const notePath = ob.normalizePath(`${noteFolder}/${fileBase}.md`);
			const idPrefix = noteId || String(Date.now());

			await this.ensureFolder(noteFolder);
			if (downloadMedia) await this.ensureFolder(mediaFolder);

			/* 已存在同名笔记 → 加序号，不覆盖 */
			let finalNotePath = notePath;
			let n = 1;
			while (await this.app.vault.adapter.exists(finalNotePath)) {
				finalNotePath = ob.normalizePath(`${noteFolder}/${fileBase}-${n}.md`);
				n++;
				if (n > 50) break;
			}

			/* 媒体 */
			const mediaLines = [];
			if (downloadMedia) {
				const errs = [];

				if (data.type === "video" && data.video) {
					if (this.settings.downloadVideo) {
						try {
							const name = await this.downloadMedia(data.video, mediaFolder, `${idPrefix}-video.mp4`);
							mediaLines.push(`<video controls src="../media/${name}" width="100%"></video>`);
						} catch (e) {
							errs.push("视频 " + e.message);
							mediaLines.push(`[视频原链](${data.video})`);
						}
					} else {
						mediaLines.push(`[视频原链](${data.video})`);
					}
				}

				let idx = 0;
				for (const imgUrl of data.images) {
					try {
						const name = await this.downloadMedia(imgUrl, mediaFolder, `${idPrefix}-${String(idx).padStart(2, "0")}.jpg`);
						if (data.type === "video") {
							mediaLines.push(`![封面](../media/${name})`);
							break; // 视频笔记只存封面
						}
						mediaLines.push(`![配图${idx + 1}](../media/${name})`);
						idx++;
					} catch (e) {
						errs.push(`图${idx + 1} ` + e.message);
					}
				}

				if (errs.length) {
					console.log("[XHS] 媒体下载失败：", errs);
					await this.logDownloadFailure(mediaFolder, errs);
					notice(`部分媒体没下载成功：${errs.slice(0, 2).join("；")}（详细原因见 media/_xhs-download-errors.log）`, 10000);
				}
			} else {
				if (data.type === "video" && data.video) mediaLines.push(`[视频原链](${data.video})`);
				data.images.forEach((u, i) => mediaLines.push(`![配图${i + 1}](${u})`));
			}

			/* 正文 */
			const noMedia = data.images.length === 0 && !data.video;
			if (noMedia && !this.settings.cookie) {
				notice("只抓到正文，没抓到图片/视频：未登录状态下小红书只返回分享卡片。去设置里填 Cookie 即可拿到全部媒体。", 10000);
			}
			const body = stripTrailingTags(stripHashTags(data.desc || "")) || "（原文无正文，可能仅图片/视频）";
			const today = new Date().toISOString().split("T")[0];

			let content = `---\n`;
			content += `title: "${data.title.replace(/"/g, "'")}"\n`;
			content += `source: ${url}\n`;
			content += `note_id: ${noteId || ""}\n`;
			if (data.author) content += `author: "${data.author.replace(/"/g, "'")}"\n`;
			content += `type: ${data.type}\n`;
			content += `date: ${today}\n`;
			content += `category: ${category || "Uncategorized"}\n`;
			if (data.tags.length) content += `tags: [${data.tags.map((t) => `"${t.replace(/"/g, "'")}"`).join(", ")}]\n`;
			content += `---\n\n# ${data.title}\n\n`;
			content += `${body}\n\n`;
			if (mediaLines.length) content += mediaLines.join("\n\n") + "\n\n";

			await this.app.vault.create(finalNotePath, content);
			const file = this.app.vault.getAbstractFileByPath(finalNotePath);
			if (file) await this.app.workspace.getLeaf(!0).openFile(file);

			this.settings.lastCategory = category;
			await this.saveSettings();

			notice(
				`已导入：${fileBase}（正文✓ ${data.images.length}图${data.type === "video" ? " + 视频" : ""}，来源解析：${data.via}）`,
				6000
			);
		} catch (e) {
			console.log("[XHS] 导入异常：", e);
			notice(`导入失败：${e.message}`, 10000);
		}
	}
};

/* ---------------- 设置面板 ---------------- */

var XiaohongshuSettingTab = class extends ob.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new ob.Setting(containerEl)
			.setName("默认文件夹")
			.setDesc("笔记按分类落到这个文件夹下的子目录，媒体统一放在 {文件夹}/media。")
			.addText((t) =>
				t
					.setPlaceholder("XHS Notes")
					.setValue(this.plugin.settings.defaultFolder)
					.onChange(async (v) => {
						this.plugin.settings.defaultFolder = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new ob.Setting(containerEl)
			.setName("默认下载媒体")
			.setDesc("勾上后，导入时默认把图片/视频下载到本地。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.downloadMedia).onChange(async (v) => {
					this.plugin.settings.downloadMedia = v;
					await this.plugin.saveSettings();
				})
			);

		new ob.Setting(containerEl)
			.setName("下载视频文件")
			.setDesc("关闭后视频只保留原链接，笔记体积更小。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.downloadVideo !== !1).onChange(async (v) => {
					this.plugin.settings.downloadVideo = v;
					await this.plugin.saveSettings();
				})
			);

		new ob.Setting(containerEl)
			.setName("小红书 Cookie（解决登录可见笔记）")
			.setDesc("Chrome 打开小红书 → F12 → Network → 任意请求 → 复制 Request Headers 里的 Cookie 整行。留空则只抓公开笔记。")
			.addTextArea((t) => {
				t.setPlaceholder("a1=...; web_session=...; xsecappid=xhs-pc-web; ...")
					.setValue(this.plugin.settings.cookie || "")
					.onChange(async (v) => {
						this.plugin.settings.cookie = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.rows = 4;
				t.inputEl.style.width = "100%";
			});

		new ob.Setting(containerEl)
			.setName("调试日志")
			.setDesc("开启后在开发者控制台打印抓取状态与 HTML 片段，排查问题用。")
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.debug).onChange(async (v) => {
					this.plugin.settings.debug = v;
					await this.plugin.saveSettings();
				})
			);

		new ob.Setting(containerEl).setName("分类").setHeading();
		containerEl.createEl("p", { text: "导入时可选分类，对应文件夹名。" });

		this.plugin.settings.categories.forEach((cat, i) => {
			const row = new ob.Setting(containerEl).setName(`分类 ${i + 1}`).addText((t) =>
				t.setValue(cat).onChange(async (v) => {
					this.plugin.settings.categories[i] = v.trim();
					await this.plugin.saveSettings();
				})
			);
			row.addButton((b) =>
				b
					.setIcon("arrow-up")
					.setTooltip("上移")
					.setDisabled(i === 0)
					.onClick(async () => {
						if (i > 0) {
							[this.plugin.settings.categories[i], this.plugin.settings.categories[i - 1]] = [
								this.plugin.settings.categories[i - 1],
								this.plugin.settings.categories[i],
							];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);
			row.addButton((b) =>
				b
					.setIcon("arrow-down")
					.setTooltip("下移")
					.setDisabled(i === this.plugin.settings.categories.length - 1)
					.onClick(async () => {
						if (i < this.plugin.settings.categories.length - 1) {
							[this.plugin.settings.categories[i], this.plugin.settings.categories[i + 1]] = [
								this.plugin.settings.categories[i + 1],
								this.plugin.settings.categories[i],
							];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);
			row.addButton((b) =>
				b.setButtonText("删除").onClick(async () => {
					this.plugin.settings.categories.splice(i, 1);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		});

		new ob.Setting(containerEl).addButton((b) =>
			b.setButtonText("新增分类").onClick(async () => {
				this.plugin.settings.categories.push("新分类");
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
};

/* ---------------- 导入弹窗（保持原样） ---------------- */

var ImportModal = class extends ob.Modal {
	constructor(app, settings, onSubmit) {
		super(app);
		this.result = null;
		this.settings = settings;
		this.onSubmit = onSubmit;
		this.selectedCategory =
			this.settings.lastCategory && this.settings.categories.includes(this.settings.lastCategory)
				? this.settings.lastCategory
				: this.settings.categories[0] || "其他";
		this.downloadMedia = this.settings.downloadMedia;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("xhs-modal-content");
		contentEl.createEl("h2", { text: "Import Xiaohongshu note" });

		const row1 = contentEl.createEl("div", { cls: "xhs-modal-row" });
		row1.createEl("p", { text: "Paste the share text below:" });
		const textarea = row1.createEl("textarea", {
			cls: "xhs-modal-textarea",
			attr: { placeholder: "e.g., 64 不叫小黄了发布了一篇小红书笔记..." },
		});

		const row2 = contentEl.createEl("div", { cls: "xhs-modal-row" });
		row2.createEl("p", { text: "Select a category:" });
		const chips = row2.createEl("div", { cls: "xhs-chip-container" });

		const refreshChips = () => {
			chips.querySelectorAll("button").forEach((b) => {
				if (b.textContent === this.selectedCategory) b.classList.add("xhs-chip--selected");
				else b.classList.remove("xhs-chip--selected");
			});
		};

		this.settings.categories.forEach((cat) => {
			const btn = chips.createEl("button", { text: cat, cls: "xhs-chip" });
			if (cat === this.selectedCategory) btn.classList.add("xhs-chip--selected");
			btn.addEventListener("click", () => {
				this.selectedCategory = cat;
				refreshChips();
			});
		});

		const other = chips.createEl("button", { text: "其他", cls: "xhs-chip" });
		if (this.selectedCategory === "其他") other.classList.add("xhs-chip--selected");
		other.addEventListener("click", () => {
			this.selectedCategory = "其他";
			refreshChips();
		});

		const dlRow = contentEl.createEl("div", { cls: ["xhs-modal-row", "xhs-download-row"] });
		const dlWrap = dlRow.createEl("div", { cls: "xhs-download-wrapper" });
		const cb = dlWrap.createEl("input", { attr: { type: "checkbox", id: "download-media-checkbox" } });
		cb.checked = this.downloadMedia;
		cb.addEventListener("change", () => {
			this.downloadMedia = cb.checked;
		});
		dlWrap.createEl("label", {
			text: "Download media locally for this import",
			cls: "xhs-download-label",
			attr: { for: "download-media-checkbox" },
		});

		const btnRow = contentEl.createEl("div", { cls: ["xhs-modal-row", "xhs-button-row"] });
		const submit = btnRow.createEl("button", { text: "Import", cls: "xhs-submit-button" });
		const fire = () => {
			this.result = {
				text: textarea.value.trim(),
				category: this.selectedCategory,
				downloadMedia: this.downloadMedia,
			};
			this.close();
		};
		submit.addEventListener("click", fire);
		textarea.addEventListener("keypress", (ev) => {
			if (ev.key === "Enter" && !ev.shiftKey) {
				ev.preventDefault();
				fire();
			}
		});
	}

	onClose() {
		this.onSubmit(this.result);
	}
};
