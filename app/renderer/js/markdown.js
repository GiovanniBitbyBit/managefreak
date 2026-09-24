// ManageFreak — rendering markdown minimale per il changelog delle release.
//
// GitHub serve le note di release in markdown: senza conversione si vedevano i
// cancelletti e gli asterischi nel menu dell'app. Il testo arriva dalla rete,
// quindi l'HTML viene neutralizzato PRIMA di applicare le regole: nessun markup
// può passare dall'esterno.
'use strict';

const Md = (() => {
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  /** Formattazione dentro la riga: grassetto, corsivo, codice, link. */
  function inline(t) {
    return escapeHtml(t)
      // **grassetto** e __grassetto__
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      // *corsivo* (non le liste: lì l'asterisco è a inizio riga e non arriva qui)
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // [testo](https://…) — solo http/https, il click apre il browser di sistema
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  }

  /** Converte il markdown in HTML (titoli, liste, righe, paragrafi). */
  function render(md) {
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
      const r = raw.trim();
      if (!r) { closeList(); continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(r);
      if (h) {
        closeList();
        const lvl = Math.min(3, h[1].length); // oltre h3 non serve in un menu
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(r)) { closeList(); out.push('<hr>'); continue; }
      const li = /^[-*+]\s+(.*)$/.exec(r);
      if (li) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${inline(r)}</p>`);
    }
    closeList();
    return out.join('');
  }

  return { render, escapeHtml };
})();

if (typeof module !== 'undefined') module.exports = Md;
if (typeof globalThis !== 'undefined') globalThis.Md = Md;
