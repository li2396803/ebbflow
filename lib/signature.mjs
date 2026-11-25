// 项目身份与署名（单一事实来源）
//
// 显式署名：页面底部的「鸣谢」与「免责声明」区块（见 web/index.html）
// 隐式标识：HTML <meta>、注释、JSON-LD、data/meta.json、HTTP 响应头、控制台 banner
//
// 想换成你自己的名字/主页，只改这个文件即可。
import crypto from "node:crypto";

export const SIGNATURE = {
  project: "ebbflow",
  projectZh: "ETF 细分行业资金流向",
  tagline: "Ebb and flow of ETF money",
  version: "3.11.0",
  author: "dreemetoo",
  authorUrl: "https://github.com/li2396803",
  repo: "https://github.com/li2396803/ebbflow",
  homepage: "https://li2396803.github.io/ebbflow/",
  license: "MIT",
  year: 2026,
  // 数据与设计的来源（显式鸣谢对象，不是水印）
  origin: {
    title: "ETF 细分行业资金流向",
    author: "生炸瓜",
    platform: "哔哩哔哩（B站）",
    bilibili: "https://space.bilibili.com/3546681834473583",
    github: "https://github.com/ysz-xiao",
    note: "86 个细分行业 / 9 大类的分类体系与看板形态源自其公开作品",
  },
};

/** 稳定指纹：不随构建时间变化，用于在任意副本里认出这份项目 */
export const FINGERPRINT = crypto
  .createHash("sha256")
  .update(`${SIGNATURE.project}:${SIGNATURE.author}:${SIGNATURE.repo}`)
  .digest("hex")
  .slice(0, 16);

export const GENERATOR = `${SIGNATURE.project}/${SIGNATURE.version} (+${SIGNATURE.repo})`;

/** 注入 <head> 的隐性标识块（注释 + meta + JSON-LD） */
export function headInjection() {
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Ebbflow",
    alternateName: [SIGNATURE.project, SIGNATURE.projectZh],
    slogan: SIGNATURE.tagline,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Node.js >= 22.5",
    author: { "@type": "Person", name: SIGNATURE.author, url: SIGNATURE.authorUrl },
    license: `https://opensource.org/licenses/${SIGNATURE.license}`,
    codeRepository: SIGNATURE.repo,
    isBasedOn: {
      "@type": "CreativeWork",
      name: SIGNATURE.origin.title,
      author: { "@type": "Person", name: SIGNATURE.origin.author, url: SIGNATURE.origin.bilibili },
      sameAs: [SIGNATURE.origin.bilibili, SIGNATURE.origin.github],
      inLanguage: "zh-CN",
    },
    identifier: FINGERPRINT,
    datePublished: `${SIGNATURE.year}`,
  };
  return [
    `<!-- ${SIGNATURE.project} · ${SIGNATURE.projectZh} · built by ${SIGNATURE.author} · ${SIGNATURE.repo} -->`,
    `<!-- signature ${FINGERPRINT} · license ${SIGNATURE.license} · based on a work by ${SIGNATURE.origin.author} (${SIGNATURE.origin.platform}) -->`,
    `<meta name="author" content="${SIGNATURE.author}">`,
    `<meta name="generator" content="${GENERATOR}">`,
    `<meta name="ebbflow:signature" content="${FINGERPRINT}">`,
    `<meta name="ebbflow:license" content="${SIGNATURE.license}">`,
    `<meta name="ebbflow:origin" content="${SIGNATURE.origin.author} @ ${SIGNATURE.origin.platform}">`,
    `<meta name="ebbflow:origin-bilibili" content="${SIGNATURE.origin.bilibili}">`,
    `<meta name="ebbflow:origin-github" content="${SIGNATURE.origin.github}">`,
    // 兼容旧键名（v3.0 之前的前端版本读的是 etf-flow:*）
    `<meta name="etf-flow:signature" content="${FINGERPRINT}">`,
    `<meta name="etf-flow:origin" content="${SIGNATURE.origin.author} @ ${SIGNATURE.origin.platform}">`,
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,
  ].join("\n");
}

/** 供前端运行时读取的签名对象（隐藏字段，不渲染） */
export function runtimeSignature() {
  return {
    project: SIGNATURE.project,
    version: SIGNATURE.version,
    author: SIGNATURE.author,
    repo: SIGNATURE.repo,
    license: SIGNATURE.license,
    fingerprint: FINGERPRINT,
    origin: SIGNATURE.origin,
  };
}

/** 把占位符替换进 HTML（构建期调用） */
export function applySignatureHtml(html) {
  return html
    .replace("<!--__SIGNATURE__-->", headInjection())
    .replaceAll("__REPO__", SIGNATURE.repo)
    .replaceAll("__AUTHOR_URL__", SIGNATURE.authorUrl)
    .replaceAll("__AUTHOR__", SIGNATURE.author)
    .replaceAll("__LICENSE__", SIGNATURE.license)
    .replaceAll("__VERSION__", SIGNATURE.version)
    .replaceAll("__YEAR__", String(SIGNATURE.year));
}
