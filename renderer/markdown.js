/**
 * renderer/markdown.js — a tiny, dependency-free, XSS-safe Markdown renderer
 * for the pet chat bubbles. All HTML is escaped FIRST (so <script> etc. can
 * never execute), then the common Markdown constructs are turned into tags:
 * fenced code blocks, headings, ordered/unordered lists, blockquotes,
 * horizontal rules, inline code, bold/italic/strikethrough, links, images and
 * auto-linked URLs. Single newlines become <br> (agent replies use them as
 * visual breaks); blank lines split paragraphs.
 *
 * Inline formatting uses a placeholder stash: code spans, images, links and
 * auto-links are extracted BEFORE bold/italic runs, so formatting markers can
 * never leak into (or be mangled by) the generated <a>/<code> tags.
 */
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Only http(s)/pet:/data-image URLs may become href/src — blocks javascript: */
  function safeUrl(url) {
    const u = (url || "").trim();
    return /^(https?:|pet:|data:image\/)/i.test(u) ? u : "";
  }

  function inline(src) {
    let s = src;
    const stash = [];
    const hold = (html) => {
      const key = `\u0000${stash.length}\u0000`;
      stash.push(html);
      return key;
    };

    // 1. inline code (never re-formatted)
    s = s.replace(/`([^`\n]+)`/g, (m, code) => hold(`<code>${code}</code>`));
    // 2. images ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      return hold(u ? `<img src="${u}" alt="${escapeHtml(alt)}">` : escapeHtml(alt));
    });
    // 3. links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
      const u = safeUrl(url);
      return hold(u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${txt}</a>` : txt);
    });
    // 4. auto-link bare URLs (preceded by whitespace / "(")
    s = s.replace(/(^|[\s(])((?:https?:\/\/|pet:\/\/)[^\s<>"')]+)/g,
      (m, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

    // 5. emphasis on the remaining (tag-free) text
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    // 6. restore the stashed code/links/images
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
    return s;
  }

  function render(src) {
    if (typeof src !== "string") return "";
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let para = []; // escaped lines of the current paragraph

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${para.join("<br>")}</p>`);
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        flushPara();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // closing fence (or past the end)
        const lang = fence[1].trim();
        out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      // blank line — paragraph break
      if (line.trim() === "") {
        flushPara();
        i++;
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const level = h[1].length;
        out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`);
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*(?:[-*_]\s*){3,}\s*$/.test(line)) {
        flushPara();
        out.push("<hr>");
        i++;
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inline(escapeHtml(quote.join("<br>")))}</blockquote>`);
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(inline(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/, ""))));
          i++;
        }
        out.push(`<ul>${items.map((it) => `<li>${it}</li>`).join("")}</ul>`);
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(inline(escapeHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ""))));
          i++;
        }
        out.push(`<ol>${items.map((it) => `<li>${it}</li>`).join("")}</ol>`);
        continue;
      }

      // ordinary paragraph line
      para.push(inline(escapeHtml(line)));
      i++;
    }
    flushPara();
    return out.join("\n");
  }

  window.PetMarkdown = { render };
})();
