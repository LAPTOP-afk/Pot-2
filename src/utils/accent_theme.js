// 主题色（accent）运行时换肤引擎
// NextUI v2 将主题色输出为 HSL 通道 CSS 变量（如 `--nextui-primary: 217 77% 55%`），
// 作用域为 `:root,.light,[data-theme=light]` 与 `.dark,[data-theme=dark]`。
// 在 <head> 末尾注入同选择器的覆盖样式表，即可在不重新构建的情况下全站换肤。
// 传空（''/null）则移除覆盖，精确回退 tailwind.config.cjs 中的内置主题色。

const STYLE_ID = 'accent-override';

// 浅色阶：50/100/200/300/400 向白混合，500/600/700/800/900 向黑混合（按内置默认阶梯校准）
const LIGHT_MIX = {
    50: { target: 'white', ratio: 0.92 },
    100: { target: 'white', ratio: 0.84 },
    200: { target: 'white', ratio: 0.7 },
    300: { target: 'white', ratio: 0.55 },
    400: { target: 'white', ratio: 0.32 },
    500: { target: 'black', ratio: 0.16 },
    600: { target: 'black', ratio: 0.28 },
    700: { target: 'black', ratio: 0.46 },
    800: { target: 'black', ratio: 0.64 },
    900: { target: 'black', ratio: 0.8 },
};

// 深色阶：小号档位偏暗（悬停底色），大号档位偏亮（深色背景上的文字/描边）
const DARK_MIX = {
    50: { target: 'black', ratio: 0.82 },
    100: { target: 'black', ratio: 0.68 },
    200: { target: 'black', ratio: 0.52 },
    300: { target: 'black', ratio: 0.36 },
    400: { target: 'black', ratio: 0.2 },
    500: { target: 'black', ratio: 0.05 },
    600: { target: 'white', ratio: 0.24 },
    700: { target: 'white', ratio: 0.4 },
    800: { target: 'white', ratio: 0.56 },
    900: { target: 'white', ratio: 0.72 },
};

export function isValidHex(hex) {
    return typeof hex === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim());
}

function normalizeHex(hex) {
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) {
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    }
    return h;
}

export function hexToRgb(hex) {
    const h = normalizeHex(hex);
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

export function rgbToHsl({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            default:
                h = (r - g) / d + 4;
        }
        h /= 6;
    }
    return { h: h * 360, s, l };
}

export function hexToHsl(hex) {
    return rgbToHsl(hexToRgb(hex));
}

// RGB 空间向白/黑混合，再转 HSL 通道字符串，色阶观感自然
function mixChannel(hex, { target, ratio }) {
    const base = hexToRgb(hex);
    const t = target === 'white' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
    const mixed = {
        r: Math.round(base.r + (t.r - base.r) * ratio),
        g: Math.round(base.g + (t.g - base.g) * ratio),
        b: Math.round(base.b + (t.b - base.b) * ratio),
    };
    const { h, s, l } = rgbToHsl(mixed);
    return `${Math.round(h * 10) / 10} ${Math.round(s * 1000) / 10}% ${
        Math.round(l * 1000) / 10
    }%`;
}

// 相对亮度（WCAG），决定主色上的文字用黑还是白
function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function buildDecls(hex, mixTable, darkDefaultLighten) {
    const decls = [];
    for (const [step, mix] of Object.entries(mixTable)) {
        decls.push(`--nextui-primary-${step}:${mixChannel(hex, mix)}`);
    }
    // DEFAULT：浅色用原色；深色在原色基础上提亮，保证深色背景上的对比度
    const defaultHex = darkDefaultLighten ? lightenHex(hex, 0.12) : hex;
    const { h, s, l } = hexToHsl(defaultHex);
    decls.push(
        `--nextui-primary:${Math.round(h * 10) / 10} ${Math.round(s * 1000) / 10}% ${
            Math.round(l * 1000) / 10
        }%`
    );
    const fg = relativeLuminance(defaultHex) > 0.55 ? '0 0% 12%' : '0 0% 100%';
    decls.push(`--nextui-primary-foreground:${fg}`);
    // focus 与内置一致取 500 档
    decls.push(`--nextui-focus:var(--nextui-primary-500)`);
    return decls.join(';');
}

function lightenHex(hex, ratio) {
    const { r, g, b } = hexToRgb(hex);
    const f = (v) => Math.round(v + (255 - v) * ratio);
    return `#${[f(r), f(g), f(b)]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`;
}

export function generateAccentCss(hex) {
    if (!isValidHex(hex)) return '';
    const light = buildDecls(hex, LIGHT_MIX, false);
    const dark = buildDecls(hex, DARK_MIX, true);
    return `:root,.light,[data-theme=light]{${light}}.dark,[data-theme=dark]{${dark}}`;
}

// 注入/移除覆盖样式表；返回是否成功应用
export function applyAccent(hex) {
    let styleEl = document.getElementById(STYLE_ID);
    if (!hex || !isValidHex(hex)) {
        if (styleEl) styleEl.remove();
        return false;
    }
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = generateAccentCss(hex);
    return true;
}

// 主色切换时临时开启颜色过渡（约 0.25s，见 style.css）
let animTimer = null;
export function pulseColorTransition() {
    const root = document.documentElement;
    root.setAttribute('data-color-anim', 'true');
    if (animTimer) clearTimeout(animTimer);
    animTimer = setTimeout(() => {
        root.removeAttribute('data-color-anim');
    }, 320);
}
