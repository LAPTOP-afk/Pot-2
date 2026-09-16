import { Button, ButtonGroup, Tooltip } from '@nextui-org/react';
import { BaseDirectory, exists, readDir, readTextFile } from '@tauri-apps/api/fs';
import { writeText } from '@tauri-apps/api/clipboard';
import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api';
import { HiTranslate } from 'react-icons/hi';
import { MdContentCopy, MdClose, MdImage } from 'react-icons/md';
import PulseLoader from 'react-spinners/PulseLoader';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import * as builtinServices from '../../services/translate';
import { invoke_plugin } from '../../utils/invoke_plugin';
import { useConfig } from '../../hooks';
import {
    ServiceSourceType,
    getServiceName,
    getServiceSouceType,
} from '../../utils/service_instance';
import { store } from '../../utils/store';

// 截图译文叠加窗：原图对应位置显示译文块，可切换译文/原图
export default function Overlay() {
    const { t } = useTranslation();

    const [base64, setBase64] = useState('');
    const [lines, setLines] = useState([]);
    const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
    const [logicalSize, setLogicalSize] = useState({ w: 0, h: 0 });
    const [mode, setMode] = useState('translation'); // translation | original
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // 全部行翻译均失败：显示可见错误提示（原图仍可查看/切换）
    const [failedAll, setFailedAll] = useState(false);

    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [sourceLanguageCfg] = useConfig('translate_source_language', 'auto');
    const [targetLanguageCfg] = useConfig('translate_target_language', 'zh_cn');
    const [secondLanguage] = useConfig('translate_second_language', 'en');
    const [serviceList] = useConfig('translate_service_list', ['deepl', 'bing']);

    // 失败/不支持行级坐标时，回退到常规图片翻译窗
    const fallbackToImageTranslate = async (ocrText) => {
        const text = (ocrText ?? '').trim();
        if (text) {
            await invoke('image_translate_text', { text });
        }
        await appWindow.close();
    };

    // 一次性扫描插件翻译目录（每次开窗仅一次，供逐行翻译复用）
    const loadPluginInfoMap = async () => {
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

    useEffect(() => {
        let cancelled = false;
        const init = async () => {
            const rect = await invoke('get_screenshot_rect');
            if (rect) {
                const sf = rect.scale_factor || 1;
                setLogicalSize({ w: rect.width / sf, h: rect.height / sf });
            }

            const imgBase64 = await invoke('get_base64');
            if (cancelled) return;
            if (!imgBase64) {
                await appWindow.close();
                return;
            }
            setBase64(imgBase64);

            let ocr;
            try {
                const raw = await invoke('system_ocr_lines', { lang: recognizeLanguage });
                ocr = JSON.parse(raw);
            } catch (e) {
                // 平台不支持坐标或 OCR 失败：先尝试普通 OCR 文本，再回退图片翻译窗
                let plain = '';
                try {
                    plain = await invoke('system_ocr', { lang: recognizeLanguage });
                } catch {
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
                const plain = (ocr.lines || []).map((l) => l.text || '').join('\n');
                await fallbackToImageTranslate(plain);
                return;
            }

            const ocrLines = ocr.lines || [];
            setImageSize({ w: ocr.image_w, h: ocr.image_h });
            // 先展示原图与行骨架（暂无译文），关闭 loading；译文随后逐行到达
            setLines(ocrLines.map((l) => ({ ...l, translation: '' })));
            setLoading(false);

            // 语言检测
            const allText = validLines.map((l) => l.text).join('\n');
            let from = sourceLanguageCfg;
            let detectLang = '';
            if (from === 'auto') {
                try {
                    detectLang = await invoke('lang_detect', { text: allText });
                    from = detectLang || 'en';
                } catch {
                    from = 'en';
                }
            }
            let to = targetLanguageCfg;
            if (sourceLanguageCfg === 'auto' && to === detectLang) {
                to = secondLanguage;
            }

            // 插件信息每窗仅扫描一次
            const pluginInfoMap = await loadPluginInfoMap();

            // 串行逐行翻译，每行完成立即补丁渲染（数十行也不阻塞、可逐块看到）
            let successCount = 0;
            for (let i = 0; i < ocrLines.length; i++) {
                const l = ocrLines[i];
                if (typeof l.x !== 'number' || !l.text) continue;
                let translation = '';
                try {
                    translation = await translateText(l.text, from, to, detectLang, pluginInfoMap);
                } catch {
                    translation = '';
                }
                if (cancelled) return;
                if (translation) {
                    successCount++;
                    setLines((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], translation };
                        return next;
                    });
                }
            }
            if (cancelled) return;
            if (successCount === 0) {
                setFailedAll(true);
            }
        };
        init().catch((e) => {
            setError(String(e));
            setLoading(false);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const copiedLines = () =>
        lines
            .filter((l) => typeof l.x === 'number')
            .map((l) => l.translation || '')
            .filter(Boolean)
            .join('\n');

    return (
        <div className='h-screen w-screen relative bg-transparent overflow-hidden text-white'>
            {base64 && (
                <img
                    src={'data:image/png;base64,' + base64}
                    alt='screenshot'
                    className='absolute inset-0 h-full w-full pointer-events-none select-none'
                    draggable={false}
                />
            )}

            {mode === 'translation' &&
                lines.map((l, i) => {
                    if (typeof l.x !== 'number' || !l.translation) return null;
                    const left = (l.x / imageSize.w) * 100;
                    const top = (l.y / imageSize.h) * 100;
                    const width = (l.w / imageSize.w) * 100;
                    const fontSize = Math.max(
                        10,
                        (l.h / imageSize.h) * logicalSize.h * 0.75
                    );
                    return (
                        <div
                            key={i}
                            className='absolute rounded-[2px] bg-black/70 flex items-center'
                            style={{
                                left: `${left}%`,
                                top: `${top}%`,
                                width: `${width}%`,
                                minHeight: `${(l.h / imageSize.h) * 100}%`,
                                fontSize: `${fontSize}px`,
                                lineHeight: 1.15,
                                padding: '0 2px',
                            }}
                        >
                            <span className='break-words'>{l.translation}</span>
                        </div>
                    );
                })}

            {loading && (
                <div className='absolute inset-0 flex items-center justify-center bg-black/40'>
                    <PulseLoader color='#ffffff' size={10} />
                </div>
            )}

            {failedAll && !loading && !error && (
                <div className='absolute left-1/2 top-[10px] -translate-x-1/2 rounded-[6px] bg-red-600/85 px-[10px] py-[4px] text-[12px] text-white whitespace-nowrap'>
                    {t('overlay.translate_failed')}
                </div>
            )}

            {!loading && !error && (
                <div className='absolute top-[6px] right-[6px] flex gap-[4px]'>
                    <ButtonGroup className='rounded-6 bg-black/60 backdrop-blur'>
                        <Tooltip content={t('overlay.toggle_view')}>
                            <Button
                                size='sm'
                                variant='light'
                                isIconOnly
                                onPress={() =>
                                    setMode(mode === 'translation' ? 'original' : 'translation')
                                }
                            >
                                {mode === 'translation' ? (
                                    <MdImage className='text-[16px] text-white' />
                                ) : (
                                    <HiTranslate className='text-[16px] text-white' />
                                )}
                            </Button>
                        </Tooltip>
                        <Tooltip content={t('overlay.copy_all')}>
                            <Button
                                size='sm'
                                variant='light'
                                isIconOnly
                                onPress={() => writeText(copiedLines())}
                            >
                                <MdContentCopy className='text-[16px] text-white' />
                            </Button>
                        </Tooltip>
                        <Tooltip content={t('overlay.close')}>
                            <Button
                                size='sm'
                                variant='light'
                                isIconOnly
                                onPress={() => appWindow.close()}
                            >
                                <MdClose className='text-[16px] text-white' />
                            </Button>
                        </Tooltip>
                    </ButtonGroup>
                </div>
            )}
        </div>
    );
}
