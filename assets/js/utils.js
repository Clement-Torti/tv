/* Small helpers shared across modules. */

/* Escapes text destined for element content. */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* Escapes text destined for a double-quoted HTML attribute. */
function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Deterministic gradient per title, so cards without a logo stay recognisable. */
function getGradient(str) {
    const key = String(str == null ? '' : str);
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = key.charCodeAt(i) + ((hash << 5) - hash);
    }
    const palettes = [
        'linear-gradient(135deg, #8E0E00 0%, #1F1C18 100%)',
        'linear-gradient(135deg, #000428 0%, #004e92 100%)',
        'linear-gradient(135deg, #240b36 0%, #c31432 100%)',
        'linear-gradient(135deg, #232526 0%, #414345 100%)',
        'linear-gradient(135deg, #3a1c71 0%, #d76d77 50%, #ffaf7b 100%)',
        'linear-gradient(135deg, #141E30 0%, #243B55 100%)'
    ];
    return palettes[Math.abs(hash) % palettes.length];
}

let toastTimer;
function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function hasLogo(channel) {
    return Boolean(channel.logo && channel.logo.length > 5);
}

function isDashStream(url) {
    return String(url).indexOf('.mpd') > -1;
}
