# PDF CMap / standard fonts

`cmaps/` 与 `standard_fonts/` 复制自 Mozilla PDF.js（`pdfjs-dist`，Apache License 2.0），
用于在纯 JS 环境下正确抽取中日韩 PDF 的文本（CMap 缺失时 pdf.js 无法映射 CID 字体）。

- 上游：https://github.com/mozilla/pdf.js
- 许可：Apache License 2.0（见 https://www.apache.org/licenses/LICENSE-2.0）
- 说明：仅包含文本抽取所需的字符映射与标准字体数据，不包含 pdf.js 源码。
