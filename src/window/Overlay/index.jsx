import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Switch,
} from '@nextui-org/react';
import { BaseDirectory, exists, readDir, readTextFile } from '@tauri-apps/api/fs';
import { writeText } from '@tauri-apps/api/clipboard';
import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api';
import {
    MdContentCopy,
    MdClose,
    MdDragIndicator,
    MdExpandLess,
    MdExpandMore,
    MdImage,
    MdLightMode,
    MdDarkMode,
    MdRefresh,
} from 'react-icons/md';
import { BiTransferAlt } from 'react-icons/bi';
import { HiTranslate } from 'react-icons/hi';
import PulseLoader from 'react-spinners/PulseLoader';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { info, error as logError } from 'tauri-plugin-log-api';

import * as builtinServices from '../../services/translate';
import { invoke_plugin } from '../../utils/invoke_plugin';
import { languageList } from '../../utils/language';
import { useConfig } from '../../hooks';
import {
    ServiceSourceType,
    getServiceName,
    getServiceSouceType,
} from '../../utils/service_instance';
import { store } from '../../utils/store';
import ResizeBlock from './ResizeBlock';

// 截图译文叠加窗：浅白块覆盖原文（可拖拽缩放），底部胶囊工具栏（语言/对照/复制/重译）
export default function Overlay() {
    const { t } = useTranslation();

    const [base64, setBase64] = useState('');
    const [lines, setLines] = useState([]);
    const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
    const [logicalSize, setLogicalSize] = useState({ w: 0, h: 0 });
    const [mode, setMode] = useState('translation'); // translation | original
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [failedAll, setFailedAll] = useState(false);
    const [retranslating, setRetranslating] = useState(false);

    // 每块会话内缩放覆盖 { [index]: {l,t,r,b} }，不持久化
    const [overrides, setOverrides] = useState({});
    const [selectedIdx, setSelectedIdx] = useState(null);

    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [sourceLanguageCfg] = useConfig('translate_source_language', 'auto');
    const [targetLanguageCfg] = useConfig('translate_target_language', 'zh_cn');
    const [secondLanguage] = useConfig('translate_second_language', 'en');
    const [serviceList] = useConfig('translate_service_list', ['deepl', 'bing']);
    const [compare, setCompare] = useConfig('overlay_compare', false);
    const [blockTheme, setBlockTheme] = useConfig('overlay_block_theme', 'light');

    // 底部工具栏空闲自动隐藏，避免遮挡底部译文；鼠标移动或点悬浮钮可唤出
    const [barVisible, setBarVisible] = useState(true);
    const barTimerRef = useRef(null);
    const menuOpenRef = useRef(false);

    // 工具栏位置（px，左上角）；null 表示默认底部居中。展开栏与收起 FAB 共用同一位置
    const [barPos, setBarPos] = useState(null);
    const barRef = useRef(null);
    const barDragRef = useRef(null);

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    // 统一拖拽入口：el 为被拖元素（展开栏或收起 FAB）
    const beginBarDrag = (e, el) => {
        e.preventDefault();
        e.stopPropagation();
        clearBarTimer();
        setBarVisible(true);
        try {
            el.setPointerCapture(e.pointerId);
        } catch {
            /* 某些 WebView 不支持时退化为 window 监听 */
        }
        const rect = el.getBoundingClientRect();
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        barDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: rect.left,
            origY: rect.top,
            w: rect.width,
            h: rect.height,
            moved: false,
        };
        const onMove = (ev) => {
            const d = barDragRef.current;
            if (!d) return;
            if (Math.abs(ev.clientX - d.startX) > 3 || Math.abs(ev.clientY - d.startY) > 3) {
                d.moved = true;
            }
            setBarPos({
                x: clamp(d.origX + (ev.clientX - d.startX), 0, Math.max(0, winW - d.w)),
                y: clamp(d.origY + (ev.clientY - d.startY), 0, Math.max(0, winH - d.h)),
            });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            scheduleHideBar();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    const clearBarTimer = () => {
        if (barTimerRef.current) {
            clearTimeout(barTimerRef.current);
            barTimerRef.current = null;
        }
    };
    const scheduleHideBar = () => {
        clearBarTimer();
        barTimerRef.current = setTimeout(() => {
            if (!menuOpenRef.current) setBarVisible(false);
        }, 2600);
    };
    const wakeBar = () => {
        setBarVisible(true);
        scheduleHideBar();
    };

    useEffect(() => {
        scheduleHideBar();
        return clearBarTimer;
    }, []);

    // 工具栏语言选择（初始跟随配置，窗内切换立即重译）
    const [sourceLang, setSourceLang] = useState('auto');
    const [targetLang, setTargetLang] = useState('zh_cn');
    const linesRef = useRef([]);
    const pluginMapRef = useRef(null);
    const startedRef = useRef(false);

    // 失败/不支持行级坐标时，回退到常规图片翻译窗
    const fallbackToImageTranslate = async (ocrText) => {
        const text = (ocrText ?? '').trim();
        logError(`[overlay] fallbackToImageTranslate textLen=${text.length}`);
        if (text) {
            await invoke('image_translate_text', { text });
        }
        await appWindow.close();
    };

    // 一次性扫描插件翻译目录（每次开窗仅一次，供逐行翻译复用）
    const loadPluginInfoMap = async () => {
        if (pluginMapRef.current) return pluginMapRef.current;
        const pluginInfoMap = {};
        if (await exists('plugins/translate', { dir: BaseDirectory.AppConfig })) {
            try {
                const plugins = await readDir('plugins/translate', {
                    dir: BaseDirectory.AppConfig,
                });
                for (const plugin of plugins) {
                    const infoStr = await readTextFile(
                        `plugins/translate/${plugin.name}/info.json`,
                        { dir: BaseDirectory.AppConfig }
                    );
                    pluginInfoMap[plugin.name] = JSON.parse(infoStr);
                }
            } catch {
                return {};
            }
        }
        pluginMapRef.current = pluginInfoMap;
        return pluginInfoMap;
    };

    // 调用首个可用翻译服务（内置或插件）
    const translateText = async (text, from, to, detectLang, pluginInfoMap) => {
        for (const instanceKey of serviceList) {
            try {
                const name = getServiceName(instanceKey);
                const config = (await store.get(instanceKey)) ?? {};
                config.enable = 'true';
                if (
                    getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN
                ) {
                    const info = pluginInfoMap[name];
                    if (!info || !(from in info.language) || !(to in info.language)) continue;
                    const [func, utils] = await invoke_plugin('translate', name);
                    const v = await func(text, info.language[from], info.language[to], {
                        config,
                        detect: detectLang,
                        setResult: () => {},
                        utils,
                    });
                    if (typeof v === 'string' && v.trim() !== '') return v.trim();
                } else {
                    const service = builtinServices[name];
                    if (!service || !(from in service.Language) || !(to in service.Language)) {
                        continue;
                    }
                    const v = await service.translate(
                        text,
                        service.Language[from],
                        service.Language[to],
                        { config }
                    );
                    if (typeof v === 'string' && v.trim() !== '') return v.trim();
                }
            } catch {
                // 尝试下一个服务
            }
        }
        return '';
    };

    // 串行逐行翻译（初次与切换语言对复用）
    const runTranslate = async (baseLines, srcCfg, tgtCfg) => {
        const validLines = baseLines.filter(
            (l) => typeof l.x === 'number' && typeof l.w === 'number'
        );
        setLines(baseLines.map((l) => ({ ...l, translation: '' })));
        setOverrides({});
        setSelectedIdx(null);
        setFailedAll(false);
        setRetranslating(true);

        const allText = validLines.map((l) => l.text).join('\n');
        let from = srcCfg;
        let detectLang = '';
        if (from === 'auto') {
            try {
                detectLang = await invoke('lang_detect', { text: allText });
                from = detectLang || 'en';
            } catch {
                from = 'en';
            }
        }
        let to = tgtCfg;
        if (srcCfg === 'auto' && to === detectLang) {
            to = secondLanguage;
        }

        const pluginInfoMap = await loadPluginInfoMap();

        let successCount = 0;
        for (let i = 0; i < baseLines.length; i++) {
            const l = baseLines[i];
            if (typeof l.x !== 'number' || !l.text) continue;
            let translation = '';
            try {
                translation = await translateText(l.text, from, to, detectLang, pluginInfoMap);
            } catch {
                translation = '';
            }
            if (translation) {
                successCount++;
                setLines((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], translation };
                    return next;
                });
            }
        }
        if (successCount === 0) {
            setFailedAll(true);
        }
        setRetranslating(false);
    };

    useEffect(() => {
        // useConfig 首帧为 null，配置异步水化后才允许启动，避免向 Rust 传入 null 参数
        if (startedRef.current) return;
        if (
            recognizeLanguage === null ||
            sourceLanguageCfg === null ||
            targetLanguageCfg === null ||
            secondLanguage === null ||
            serviceList === null
        ) {
            return;
        }
        startedRef.current = true;
        const ocrLang = recognizeLanguage || 'auto';
        let cancelled = false;
        const onError = (e) => logError(`[overlay] window error: ${String(e.message)}`);
        const onReject = (e) => logError(`[overlay] unhandled rejection: ${String(e.reason)}`);
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onReject);
        const init = async () => {
            info('[overlay] init start');
            const rect = await invoke('get_screenshot_rect');
            info(`[overlay] rect=${JSON.stringify(rect)}`);
            if (rect) {
                const sf = rect.scale_factor || 1;
                setLogicalSize({ w: rect.width / sf, h: rect.height / sf });
            }

            const imgBase64 = await invoke('get_base64');
            if (cancelled) return;
            if (!imgBase64) {
                logError('[overlay] get_base64 empty -> close');
                await appWindow.close();
                return;
            }
            info(`[overlay] base64 len=${imgBase64.length}`);
            setBase64(imgBase64);

            let ocr;
            try {
                const raw = await invoke('system_ocr_lines', { lang: ocrLang });
                ocr = JSON.parse(raw);
                info(
                    `[overlay] ocr_lines ok: image=${ocr.image_w}x${ocr.image_h} lines=${(ocr.lines || []).length}`
                );
            } catch (e) {
                logError(`[overlay] system_ocr_lines failed: ${String(e)}`);
                let plain = '';
                try {
                    plain = await invoke('system_ocr', { lang: ocrLang });
                    info(`[overlay] fallback system_ocr plain len=${plain.length}`);
                } catch (e2) {
                    logError(`[overlay] fallback system_ocr also failed: ${String(e2)}`);
                    plain = '';
                }
                await fallbackToImageTranslate(plain);
                return;
            }
            if (cancelled) return;

            const validLines = (ocr.lines || []).filter(
                (l) => typeof l.x === 'number' && typeof l.w === 'number'
            );
            if (validLines.length === 0) {
                logError(
                    `[overlay] no coordinate lines (total=${(ocr.lines || []).length}) -> fallback`
                );
                const plain = (ocr.lines || []).map((l) => l.text || '').join('\n');
                await fallbackToImageTranslate(plain);
                return;
            }

            const ocrLines = ocr.lines || [];
            linesRef.current = ocrLines;
            setImageSize({ w: ocr.image_w, h: ocr.image_h });
            // 先展示原图与行骨架（暂无译文），关闭 loading；译文随后逐行到达
            setLines(ocrLines.map((l) => ({ ...l, translation: '' })));
            setSourceLang(sourceLanguageCfg);
            setTargetLang(targetLanguageCfg);
            setLoading(false);

            await runTranslate(ocrLines, sourceLanguageCfg, targetLanguageCfg);
        };
        init().catch((e) => {
            logError(`[overlay] init crashed: ${String(e)}`);
            setError(String(e));
            setLoading(false);
        });
        return () => {
            cancelled = true;
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onReject);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recognizeLanguage, sourceLanguageCfg, targetLanguageCfg, secondLanguage, serviceList]);

    useEffect(() => {
        linesRef.current = lines;
    }, [lines]);

    // 展开/收起后按当前栏尺寸重新约束位置，避免窄 FAB 的坐标导致宽栏溢出窗口
    useEffect(() => {
        if (!barVisible || !barPos) return;
        const el = barRef.current;
        if (!el) return;
        setBarPos((p) =>
            p
                ? {
                      x: clamp(p.x, 0, Math.max(0, window.innerWidth - el.offsetWidth)),
                      y: clamp(p.y, 0, Math.max(0, window.innerHeight - el.offsetHeight)),
                  }
                : p
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [barVisible]);

    const changeSource = (key) => {
        setSourceLang(key);
        runTranslate(linesRef.current, key, targetLang);
    };
    const changeTarget = (key) => {
        setTargetLang(key);
        runTranslate(linesRef.current, sourceLang, key);
    };
    const swapLanguages = () => {
        if (sourceLang === 'auto') return;
        const next = sourceLang;
        setSourceLang(targetLang);
        setTargetLang(next);
        runTranslate(linesRef.current, targetLang, next);
    };

    const copiedLines = () =>
        lines
            .filter((l) => typeof l.x === 'number')
            .map((l) => l.translation || '')
            .filter(Boolean)
            .join('\n');

    const baseEdges = (l) => ({
        l: (l.x / imageSize.w) * 100,
        t: (l.y / imageSize.h) * 100,
        r: ((l.x + l.w) / imageSize.w) * 100,
        b: ((l.y + l.h) / imageSize.h) * 100,
    });

    const narrow = logicalSize.w > 0 && logicalSize.w < 420;
    const showBlocks = mode === 'translation';

    return (
        <div
            className='h-screen w-screen relative bg-transparent overflow-hidden text-white'
            onMouseMove={wakeBar}
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) setSelectedIdx(null);
            }}
        >
            {base64 && (
                <img
                    src={'data:image/png;base64,' + base64}
                    alt='screenshot'
                    className='absolute inset-0 h-full w-full pointer-events-none select-none'
                    draggable={false}
                />
            )}

            {showBlocks &&
                lines.map((l, i) => {
                    if (typeof l.x !== 'number') return null;
                    if (!l.translation && !(compare && l.text)) return null;
                    const fontSize = Math.max(
                        10,
                        (l.h / imageSize.h) * logicalSize.h * (compare ? 0.62 : 0.75)
                    );
                    const edges = overrides[i] || baseEdges(l);
                    return (
                        <ResizeBlock
                            key={i}
                            edges={edges}
                            fontSize={fontSize}
                            blockTheme={blockTheme}
                            compare={compare}
                            sourceText={l.text}
                            translation={l.translation}
                            selected={selectedIdx === i}
                            onSelect={() => setSelectedIdx(i)}
                            onResize={(next) =>
                                setOverrides((prev) => ({ ...prev, [i]: next }))
                            }
                        />
                    );
                })}

            {loading && (
                <div className='absolute inset-0 flex items-center justify-center bg-black/40'>
                    <PulseLoader color='#ffffff' size={10} />
                </div>
            )}

            {retranslating && !loading && (
                <div className='absolute top-[8px] left-1/2 -translate-x-1/2'>
                    <PulseLoader color='#ff6a3d' size={7} />
                </div>
            )}

            {failedAll && !loading && !error && (
                <div className='absolute left-1/2 top-[10px] -translate-x-1/2 rounded-[6px] bg-red-600/85 px-[10px] py-[4px] text-[12px] text-white whitespace-nowrap'>
                    {t('overlay.translate_failed')}
                </div>
            )}

            {!loading && !error && !barVisible && (
                <button
                    type='button'
                    onPointerDown={(e) => beginBarDrag(e, e.currentTarget)}
                    onClick={() => {
                        const d = barDragRef.current;
                        if (d?.moved) {
                            d.moved = false;
                            return;
                        }
                        wakeBar();
                    }}
                    style={barPos ? { left: barPos.x, top: barPos.y } : undefined}
                    className={`absolute flex h-[30px] w-[46px] cursor-grab items-center justify-center rounded-full bg-neutral-900/85 text-white backdrop-blur hover:bg-neutral-800 active:cursor-grabbing touch-none ${
                        barPos ? '' : 'bottom-[8px] left-1/2 -translate-x-1/2'
                    }`}
                >
                    <MdExpandLess className='text-[20px]' />
                </button>
            )}

            {!loading && !error && barVisible && (
                <div
                    ref={barRef}
                    onMouseEnter={clearBarTimer}
                    onMouseLeave={scheduleHideBar}
                    style={barPos ? { left: barPos.x, top: barPos.y } : undefined}
                    className={`absolute flex items-center gap-[2px] rounded-full bg-neutral-900/90 px-[6px] py-[3px] text-white max-w-[96%] ${
                        barPos ? '' : 'bottom-[8px] left-1/2 -translate-x-1/2'
                    }`}
                >
                    {/* 拖动手柄 */}
                    <span
                        onPointerDown={(e) => beginBarDrag(e, barRef.current)}
                        title={t('overlay.drag_toolbar')}
                        className='flex h-[24px] w-[16px] shrink-0 cursor-grab touch-none items-center justify-center text-white/45 hover:text-white/90 active:cursor-grabbing'
                    >
                        <MdDragIndicator className='text-[18px]' />
                    </span>
                    {/* 源语言 */}
                    <Dropdown
                        onOpenChange={(o) => {
                            menuOpenRef.current = o;
                            if (o) clearBarTimer();
                            else scheduleHideBar();
                        }}
                    >
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='light'
                                title={t('overlay.source_lang')}
                                className='text-white min-w-0 h-[28px]'
                            >
                                <span className={narrow ? 'max-w-[58px] truncate' : 'max-w-[92px] truncate'}>
                                    {t(`languages.${sourceLang}`)}
                                </span>
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='source language'
                            className='max-h-[46vh] overflow-y-auto'
                            onAction={(key) => changeSource(key)}
                        >
                            <DropdownItem key='auto'>{t('languages.auto')}</DropdownItem>
                            {languageList.map((x) => (
                                <DropdownItem key={x}>{t(`languages.${x}`)}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={t('overlay.swap')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        isDisabled={sourceLang === 'auto'}
                        onPress={swapLanguages}
                    >
                        <BiTransferAlt className='text-[15px]' />
                    </Button>

                    {/* 目标语言 */}
                    <Dropdown
                        onOpenChange={(o) => {
                            menuOpenRef.current = o;
                            if (o) clearBarTimer();
                            else scheduleHideBar();
                        }}
                    >
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='light'
                                title={t('overlay.target_lang')}
                                className='text-white min-w-0 h-[28px]'
                            >
                                <span className={narrow ? 'max-w-[58px] truncate' : 'max-w-[92px] truncate'}>
                                    {t(`languages.${targetLang}`)}
                                </span>
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='target language'
                            className='max-h-[46vh] overflow-y-auto'
                            onAction={(key) => changeTarget(key)}
                        >
                            {languageList.map((x) => (
                                <DropdownItem key={x}>{t(`languages.${x}`)}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>

                    <span className='mx-[3px] h-[18px] w-px bg-white/20' />

                    {/* 对照 */}
                    {!narrow && (
                        <label className='flex items-center gap-[4px] px-[4px] cursor-pointer select-none'>
                            <span className='text-[12px] text-white/85 whitespace-nowrap'>
                                {t('overlay.compare')}
                            </span>
                            <Switch
                                size='sm'
                                isSelected={compare}
                                onValueChange={(v) => setCompare(v)}
                                classNames={{ wrapper: 'h-[18px] w-[32px]' }}
                            />
                        </label>
                    )}

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={t('overlay.toggle_view')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        onPress={() =>
                            setMode(mode === 'translation' ? 'original' : 'translation')
                        }
                    >
                        {mode === 'translation' ? (
                            <MdImage className='text-[15px]' />
                        ) : (
                            <HiTranslate className='text-[15px]' />
                        )}
                    </Button>

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={blockTheme === 'light' ? t('overlay.dark_block') : t('overlay.light_block')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        onPress={() =>
                            setBlockTheme(blockTheme === 'light' ? 'dark' : 'light')
                        }
                    >
                        {blockTheme === 'light' ? (
                            <MdDarkMode className='text-[15px]' />
                        ) : (
                            <MdLightMode className='text-[15px]' />
                        )}
                    </Button>

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={t('overlay.retranslate')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        isDisabled={retranslating}
                        onPress={() => runTranslate(linesRef.current, sourceLang, targetLang)}
                    >
                        <MdRefresh className='text-[15px]' />
                    </Button>

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={t('overlay.copy_all')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        onPress={() => writeText(copiedLines())}
                    >
                        <MdContentCopy className='text-[15px]' />
                    </Button>

                    <Button
                        size='sm'
                        variant='light'
                        isIconOnly
                        title={t('overlay.close')}
                        className='text-white h-[28px] w-[28px] min-w-0'
                        onPress={() => appWindow.close()}
                    >
                        <MdClose className='text-[15px]' />
                    </Button>

                    <span className='mx-[2px] h-[18px] w-px bg-white/20' />

                    {/* 手动折叠工具栏 */}
                    <button
                        type='button'
                        onClick={() => setBarVisible(false)}
                        className='flex h-[24px] w-[24px] items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white'
                    >
                        <MdExpandMore className='text-[18px]' />
                    </button>
                </div>
            )}
        </div>
    );
}
