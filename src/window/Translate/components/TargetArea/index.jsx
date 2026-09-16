import {
    Card,
    CardBody,
    CardHeader,
    CardFooter,
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@nextui-org/react';
import { BiCollapseVertical, BiExpandVertical } from 'react-icons/bi';
import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import { sendNotification } from '@tauri-apps/api/notification';
import React, { useEffect, useState, useRef } from 'react';
import { writeText } from '@tauri-apps/api/clipboard';
import PulseLoader from 'react-spinners/PulseLoader';
import { TbTransformFilled } from 'react-icons/tb';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { semanticColors } from '@nextui-org/theme';
import toast, { Toaster } from 'react-hot-toast';
import { MdContentCopy, MdFindReplace } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import Database from 'tauri-plugin-sql-api';
import { GiCycle } from 'react-icons/gi';
import { useTheme } from 'next-themes';
import { useAtom, useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';
import { useSpring, animated } from '@react-spring/web';
import useMeasure from 'react-use-measure';
import { invoke } from '@tauri-apps/api';
import { appWindow } from '@tauri-apps/api/window';

import * as builtinCollectionServices from '../../../../services/collection';
import { sourceLanguageAtom, targetLanguageAtom } from '../LanguageArea';
import { useConfig, useToastStyle, useVoice } from '../../../../hooks';
import { sourceTextAtom, detectLanguageAtom, replaceModeAtom, windowTypeAtom } from '../SourceArea';
import { setBlurSuppress } from '../../blur_guard';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import * as builtinTtsServices from '../../../../services/tts';

import { info, error as logError } from 'tauri-plugin-log-api';
import {
    INSTANCE_NAME_CONFIG_KEY,
    ServiceSourceType,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherPluginService,
} from '../../../../utils/service_instance';

let translateID = [];

export default function TargetArea(props) {
    const { index, name, translateServiceInstanceList, pluginList, serviceInstanceConfigMap, ...drag } = props;

    const [currentTranslateServiceInstanceKey, setCurrentTranslateServiceInstanceKey] = useState(name);
    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    const [appFontSize] = useConfig('app_font_size', 16);
    const [collectionServiceList] = useConfig('collection_service_list', []);
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');
    const [historyDisable] = useConfig('history_disable', false);
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [error, setError] = useState('');

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [clipboardMonitor] = useConfig('clipboard_monitor', false);
    const [replaceMode, setReplaceMode] = useAtom(replaceModeAtom);
    const [windowType] = useAtom(windowTypeAtom);
    const [replaceRestoreClipboard] = useConfig('replace_restore_clipboard', true);
    const [replaceSuccessNotify] = useConfig('replace_success_notify', true);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const toastStyle = useToastStyle();
    const speak = useVoice();
    const theme = useTheme();

    useEffect(() => {
        if (error) {
            logError(`[${currentTranslateServiceInstanceKey}]happened error: ` + error);
        }
    }, [error]);

    // listen to translation
    useEffect(() => {
        setResult('');
        setError('');
        if (
            sourceText.trim() !== '' &&
            sourceLanguage &&
            targetLanguage &&
            autoCopy !== null &&
            hideWindow !== null &&
            clipboardMonitor !== null
        ) {
            if (autoCopy === 'source' && !clipboardMonitor && !replaceMode) {
                writeText(sourceText).then(() => {
                    if (hideWindow) {
                        sendNotification({ title: t('common.write_clipboard'), body: sourceText });
                    }
                });
            }
            translate();
        }
    }, [
        sourceText,
        sourceLanguage,
        targetLanguage,
        autoCopy,
        hideWindow,
        currentTranslateServiceInstanceKey,
        clipboardMonitor,
    ]);

    // todo: history panel use service instance key
    const addToHistory = async (text, source, target, serviceInstanceKey, result) => {
        const db = await Database.load('sqlite:history.db');

        await db
            .execute(
                'INSERT into history (text, source, target, service, result, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                [text, source, target, serviceInstanceKey, result, Date.now()]
            )
            .then(
                (v) => {
                    db.close();
                },
                (e) => {
                    db.execute(
                        'CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,service TEXT NOT NULL, result TEXT NOT NULL,timestamp INTEGER NOT NULL)'
                    ).then(() => {
                        db.close();
                        addToHistory(text, source, target, serviceInstanceKey, result);
                    });
                }
            );
    };

    function invokeOnce(fn) {
        let isInvoke = false;

        return (...args) => {
            if (isInvoke) {
                return;
            } else {
                fn(...args);
                isInvoke = true;
            }
        };
    }

    const translate = async () => {
        let id = nanoid();
        translateID[index] = id;

        const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);

        if (whetherPluginService(currentTranslateServiceInstanceKey)) {
            const pluginInfo = pluginList['translate'][translateServiceName];
            if (sourceLanguage in pluginInfo.language && targetLanguage in pluginInfo.language) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                instanceConfig['enable'] = 'true';
                const setHideOnce = invokeOnce(setHide);
                let [func, utils] = await invoke_plugin('translate', translateServiceName);
                func(sourceText.trim(), pluginInfo.language[sourceLanguage], pluginInfo.language[newTargetLanguage], {
                    config: instanceConfig,
                    detect: detectLanguage,
                    setResult: (v) => {
                        if (translateID[index] !== id) return;
                        setResult(v);
                        setHideOnce(false);
                    },
                    utils,
                }).then(
                    async (v) => {
                        info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                        if (translateID[index] !== id) return;
                        setResult(typeof v === 'string' ? v.trim() : v);
                        setIsLoading(false);
                        if (v !== '') {
                            setHideOnce(false);
                        }
                        if (!historyDisable) {
                            addToHistory(
                                sourceText.trim(),
                                detectLanguage,
                                newTargetLanguage,
                                translateServiceName,
                                typeof v === 'string' ? v.trim() : v
                            );
                        }
                        // 静默"翻译并替换原文"：成功粘贴后跳过自动复制逻辑
                        if (await trySilentReplace(v)) {
                            return;
                        }
                        if (index === 0 && !clipboardMonitor) {
                            switch (autoCopy) {
                                case 'target':
                                    writeText(v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({ title: t('common.write_clipboard'), body: v });
                                        }
                                    });
                                    break;
                                case 'source_target':
                                    writeText(sourceText.trim() + '\n\n' + v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({
                                                title: t('common.write_clipboard'),
                                                body: sourceText.trim() + '\n\n' + v,
                                            });
                                        }
                                    });
                                    break;
                                default:
                                    break;
                            }
                        }
                    },
                    (e) => {
                        info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                        if (translateID[index] !== id) return;
                        setIsLoading(false);
                        if (handleReplaceModeFailure(e.toString())) return;
                        setError(e.toString());
                    }
                );
            } else {
                if (handleReplaceModeFailure('Language not supported')) return;
                setError('Language not supported');
            }
        } else {
            const LanguageEnum = builtinServices[translateServiceName].Language;
            if (sourceLanguage in LanguageEnum && targetLanguage in LanguageEnum) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(true);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                const setHideOnce = invokeOnce(setHide);
                builtinServices[translateServiceName]
                    .translate(sourceText.trim(), LanguageEnum[sourceLanguage], LanguageEnum[newTargetLanguage], {
                        config: instanceConfig,
                        detect: detectLanguage,
                        setResult: (v) => {
                            if (translateID[index] !== id) return;
                            setResult(v);
                            setHideOnce(false);
                        },
                    })
                    .then(
                        (v) => {
                            info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                            if (translateID[index] !== id) return;
                            setResult(typeof v === 'string' ? v.trim() : v);
                            setIsLoading(false);
                            if (v !== '') {
                                setHideOnce(false);
                            }
                            if (!historyDisable) {
                                addToHistory(
                                    sourceText.trim(),
                                    detectLanguage,
                                    newTargetLanguage,
                                    translateServiceName,
                                    typeof v === 'string' ? v.trim() : v
                                );
                            }
                            // 静默"翻译并替换原文"：成功粘贴后跳过自动复制逻辑
                            (async () => {
                                if (await trySilentReplace(v)) return;
                                if (index === 0 && !clipboardMonitor) {
                                    switch (autoCopy) {
                                        case 'target':
                                            writeText(v).then(() => {
                                                if (hideWindow) {
                                                    sendNotification({ title: t('common.write_clipboard'), body: v });
                                                }
                                            });
                                            break;
                                        case 'source_target':
                                            writeText(sourceText.trim() + '\n\n' + v).then(() => {
                                                if (hideWindow) {
                                                    sendNotification({
                                                        title: t('common.write_clipboard'),
                                                        body: sourceText.trim() + '\n\n' + v,
                                                    });
                                                }
                                            });
                                            break;
                                        default:
                                            break;
                                    }
                                }
                            })();
                        },
                        (e) => {
                            info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                            if (translateID[index] !== id) return;
                            setIsLoading(false);
                            if (handleReplaceModeFailure(e.toString())) return;
                            setError(e.toString());
                        }
                    );
            } else {
                if (handleReplaceModeFailure('Language not supported')) return;
                setError('Language not supported');
            }
        }
    };

    // 静默"翻译并替换原文"：仅 index===0 的字符串结果可粘贴
    // 成功返回 true（调用方应跳过后续自动复制逻辑）；失败回退为普通展示窗口
    const trySilentReplace = async (v) => {
        if (index !== 0 || !replaceMode) return false;
        if (typeof v === 'string' && v.trim() !== '') {
            try {
                await invoke('paste_replace', {
                    text: v.trim(),
                    restoreClipboard: replaceRestoreClipboard,
                });
                if (replaceSuccessNotify) {
                    sendNotification({ title: t('translate.replace_success'), body: v.trim() });
                }
                // 替换完成：关闭隐藏窗（重建即复位 replaceMode），不残留后台窗口
                appWindow.close();
                return true;
            } catch (e) {
                info(`[${currentTranslateServiceInstanceKey}]paste_replace failed: ${e}`);
                setReplaceMode(false);
                setBlurSuppress(false);
                await appWindow.show();
                toast.error(t('translate.replace_failed'), { style: toastStyle });
                return false;
            }
        }
        // 非文本结果（如词典对象）无法粘贴：回退为普通展示窗口
        setReplaceMode(false);
        setBlurSuppress(false);
        await appWindow.show();
        toast.error(t('translate.replace_failed'), { style: toastStyle });
        return false;
    };

    // replaceMode 下翻译被拒绝/语言不支持：发系统通知并关闭隐藏窗。
    // 返回 true 表示已按静默流程处理（调用方应跳过普通 setError 展示）。
    const handleReplaceModeFailure = (detail) => {
        if (index !== 0 || !replaceMode) return false;
        setReplaceMode(false);
        sendNotification({
            title: t('translate.replace_failed'),
            body: String(detail ?? '').slice(0, 500),
        });
        appWindow.close();
        return true;
    };

    // 结果窗手动点击"替换原文"：先隐藏窗口，恢复焦点后粘贴，完成后关闭
    const handleManualReplace = async () => {
        if (typeof result !== 'string' || result.trim() === '') return;
        // 粘贴期间窗口隐藏且焦点在目标应用，屏蔽 blur 自动关闭直到替换结束
        setBlurSuppress(true);
        await appWindow.hide();
        try {
            await invoke('paste_replace', {
                text: result.trim(),
                restoreClipboard: replaceRestoreClipboard,
            });
            sendNotification({ title: t('translate.replace_success'), body: result.trim() });
            appWindow.close();
        } catch (e) {
            // 失败时重新展示窗口，保留结果供手动复制
            setBlurSuppress(false);
            await appWindow.show();
            throw e;
        }
    };

    // hide empty textarea
    useEffect(() => {
        if (textAreaRef.current !== null) {
            textAreaRef.current.style.height = '0px';
            if (result !== '') {
                textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
            }
        }
    }, [result]);

    // refresh tts config
    useEffect(() => {
        if (ttsServiceList && getServiceSouceType(ttsServiceList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(ttsServiceList[0])}/info.json`, {
                dir: BaseDirectory.AppConfig,
            }).then((infoStr) => {
                setTtsPluginInfo(JSON.parse(infoStr));
            });
        }
    }, [ttsServiceList]);

    // 通用 TTS：可朗读任意文本与语言（词典对象结果朗读源语言）
    const speakText = async (text, lang) => {
        if (!text) return;
        const instanceKey = ttsServiceList[0];
        if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            const pluginConfig = serviceInstanceConfigMap[instanceKey];
            if (!ttsPluginInfo || !(lang in ttsPluginInfo.language)) {
                throw new Error('Language not supported');
            }
            let [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
            let data = await func(text, ttsPluginInfo.language[lang], {
                config: pluginConfig,
                utils,
            });
            speak(data);
        } else {
            const service = builtinTtsServices[getServiceName(instanceKey)];
            if (!(lang in service.Language)) {
                throw new Error('Language not supported');
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey];
            let data = await service.tts(text, service.Language[lang], {
                config: instanceConfig,
            });
            speak(data);
        }
    };

    // 词典结果源语言：auto 时取检测语言
    const dictSourceLanguage = sourceLanguage === 'auto' ? detectLanguage : sourceLanguage;

    // 拍平词典对象用于复制（音标/释义/词组/例句，去除 HTML 标签）
    const flattenDictionary = (r) => {
        const stripHtml = (s) =>
            String(s ?? '')
                .replace(/<[^>]*>/g, '')
                .trim();
        const parts = [];
        r.pronunciations?.forEach((p) => {
            const line = [p.region, p.symbol].filter(Boolean).join(' ');
            if (line) parts.push(line);
        });
        r.explanations?.forEach((group) => {
            const trait = group.trait ? `${group.trait} ` : '';
            group.explains?.forEach((explain, i) => {
                const line = (i === 0 ? trait : '') + stripHtml(explain);
                if (line) parts.push(line);
            });
        });
        r.associations?.forEach((a) => {
            const line = stripHtml(a);
            if (line) parts.push(line);
        });
        r.sentence?.forEach((s, i) => {
            const source = stripHtml(s.source);
            const target = stripHtml(s.target);
            if (source) parts.push(`${i + 1}. ${source}`);
            if (target) parts.push(`   ${target}`);
        });
        return parts.join('\n');
    };

    const handleSpeak = () => speakText(result, targetLanguage);

    const [boundRef, bounds] = useMeasure({ scroll: true });
    const springs = useSpring({
        from: { height: 0 },
        to: { height: hide ? 0 : bounds.height },
    });

    return (
        <Card
            shadow='none'
            className='rounded-[10px]'
        >
            <Toaster />
            <CardHeader
                className={`flex justify-between py-1 px-0 bg-content2 h-[30px] ${hide ? 'rounded-[10px]' : 'rounded-t-[10px]'}`}
                {...drag}
            >
                {/* current service instance and available service instance to change */}
                <div className='flex'>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='solid'
                                className='bg-transparent'
                                startContent={
                                    whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                        <img
                                            src={
                                                pluginList['translate'][
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                ].icon
                                            }
                                            className='h-[20px] my-auto'
                                        />
                                    ) : (
                                        <img
                                            src={
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)].info
                                                    .icon
                                            }
                                            className='h-[20px] my-auto'
                                        />
                                    )
                                }
                            >
                                {whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                    <div className='my-auto'>{`${getInstanceName(currentTranslateServiceInstanceKey, () => pluginList['translate'][getServiceName(currentTranslateServiceInstanceKey)].display)} `}</div>
                                ) : (
                                    <div className='my-auto'>
                                        {getInstanceName(currentTranslateServiceInstanceKey, () =>
                                            t(
                                                `services.translate.${getServiceName(currentTranslateServiceInstanceKey)}.title`
                                            )
                                        )}
                                    </div>
                                )}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='app language'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => {
                                setCurrentTranslateServiceInstanceKey(key);
                            }}
                        >
                            {translateServiceInstanceList.map((instanceKey) => {
                                return (
                                    <DropdownItem
                                        key={instanceKey}
                                        startContent={
                                            whetherPluginService(instanceKey) ? (
                                                <img
                                                    src={pluginList['translate'][getServiceName(instanceKey)].icon}
                                                    className='h-[20px] my-auto'
                                                />
                                            ) : (
                                                <img
                                                    src={builtinServices[getServiceName(instanceKey)].info.icon}
                                                    className='h-[20px] my-auto'
                                                />
                                            )
                                        }
                                    >
                                        {whetherPluginService(instanceKey) ? (
                                            <div className='my-auto'>{`${getInstanceName(instanceKey, () => pluginList['translate'][getServiceName(instanceKey)].display)} `}</div>
                                        ) : (
                                            <div className='my-auto'>
                                                {getInstanceName(instanceKey, () =>
                                                    t(`services.translate.${getServiceName(instanceKey)}.title`)
                                                )}
                                            </div>
                                        )}
                                    </DropdownItem>
                                );
                            })}
                        </DropdownMenu>
                    </Dropdown>
                    <PulseLoader
                        loading={isLoading}
                        color={theme === 'dark' ? semanticColors.dark.default[500] : semanticColors.light.default[500]}
                        size={8}
                        cssOverride={{
                            display: 'inline-block',
                            margin: 'auto',
                            marginLeft: '20px',
                        }}
                    />
                </div>
                {/* content collapse */}
                <div className='flex'>
                    <Button
                        size='sm'
                        isIconOnly
                        variant='light'
                        className='h-[20px] w-[20px]'
                        onPress={() => setHide(!hide)}
                    >
                        {hide ? (
                            <BiExpandVertical className='text-[16px]' />
                        ) : (
                            <BiCollapseVertical className='text-[16px]' />
                        )}
                    </Button>
                </div>
            </CardHeader>
            <animated.div style={{ ...springs }}>
                <div ref={boundRef}>
                    {/* result content */}
                    <CardBody className={`p-[12px] pb-0 ${hide && 'h-0 p-0'}`}>
                        {typeof result === 'string' ? (
                            <textarea
                                ref={textAreaRef}
                                className={`text-[${appFontSize}px] h-0 resize-none bg-transparent select-text outline-none`}
                                readOnly
                                value={result}
                            />
                        ) : (
                            <div>
                                {result['pronunciations'] &&
                                    result['pronunciations'].map((pronunciation) => {
                                        return (
                                            <div key={nanoid()}>
                                                {pronunciation['region'] && (
                                                    <span
                                                        className={`text-[${appFontSize}px] mr-[12px] text-default-500`}
                                                    >
                                                        {pronunciation['region']}
                                                    </span>
                                                )}
                                                {pronunciation['symbol'] && (
                                                    <span
                                                        className={`text-[${appFontSize}px] mr-[12px] text-default-500`}
                                                    >
                                                        {pronunciation['symbol']}
                                                    </span>
                                                )}
                                                {pronunciation['voice'] && pronunciation['voice'] !== '' && (
                                                    <HiOutlineVolumeUp
                                                        className={`text-[${appFontSize}px] inline-block my-auto cursor-pointer`}
                                                        onClick={() => {
                                                            speak(pronunciation['voice']);
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                {result['explanations'] &&
                                    result['explanations'].map((explanations) => {
                                        return (
                                            <div key={nanoid()}>
                                                {explanations['explains'] &&
                                                    explanations['explains'].map((explain, index) => {
                                                        return (
                                                            <span key={nanoid()}>
                                                                {index === 0 ? (
                                                                    <>
                                                                        <span
                                                                            className={`text-[${appFontSize - 2}px] text-default-500 mr-[12px]`}
                                                                        >
                                                                            {explanations['trait']}
                                                                        </span>
                                                                        <span
                                                                            className={`font-bold text-[${appFontSize}px] select-text`}
                                                                        >
                                                                            {explain}
                                                                        </span>
                                                                        <br />
                                                                    </>
                                                                ) : (
                                                                    <span
                                                                        className={`text-[${appFontSize - 2}px] text-default-500 select-text mr-1`}
                                                                        key={nanoid()}
                                                                    >
                                                                        {explain}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                            </div>
                                        );
                                    })}
                                <br />
                                {result['associations'] &&
                                    result['associations'].map((association) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span className={`text-[${appFontSize}px] text-default-500`}>
                                                    {association}
                                                </span>
                                            </div>
                                        );
                                    })}
                                {result['sentence'] &&
                                    result['sentence'].map((sentence, index) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span className={`text-[${appFontSize - 2}px] mr-[12px]`}>
                                                    {index + 1}.
                                                </span>
                                                {sentence['source'] &&
                                                    sentence['source'].replace(/<[^>]*>/g, '').trim() !== '' && (
                                                        <HiOutlineVolumeUp
                                                            className='text-[14px] inline-block mr-[6px] cursor-pointer text-default-500'
                                                            onClick={() => {
                                                                speakText(
                                                                    sentence['source'].replace(/<[^>]*>/g, ''),
                                                                    dictSourceLanguage
                                                                ).catch((e) => {
                                                                    toast.error(e.toString(), {
                                                                        style: toastStyle,
                                                                    });
                                                                });
                                                            }}
                                                        />
                                                    )}
                                                <>
                                                    {sentence['source'] && (
                                                        <span
                                                            className={`text-[${appFontSize}px] select-text`}
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['source'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                                <>
                                                    {sentence['target'] && (
                                                        <div
                                                            className={`text-[${appFontSize}px] select-text text-default-500`}
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['target'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                        {error !== '' ? (
                            error.split('\n').map((v) => {
                                return (
                                    <p
                                        key={v}
                                        className={`text-[${appFontSize}px] text-red-500`}
                                    >
                                        {v}
                                    </p>
                                );
                            })
                        ) : (
                            <></>
                        )}
                    </CardBody>
                    <CardFooter
                        className={`bg-content1 rounded-none rounded-b-[10px] flex px-[12px] p-[5px] ${hide && 'hidden'}`}
                    >
                        <ButtonGroup>
                            {/* speak button */}
                            <Tooltip content={t('translate.speak')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={!result}
                                    onPress={() => {
                                        const p =
                                            typeof result === 'string'
                                                ? handleSpeak()
                                                : speakText(sourceText, dictSourceLanguage);
                                        p.catch((e) => {
                                            toast.error(e.toString(), { style: toastStyle });
                                        });
                                    }}
                                >
                                    <HiOutlineVolumeUp className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* copy button */}
                            <Tooltip content={t('translate.copy')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={!result}
                                    onPress={() => {
                                        writeText(
                                            typeof result === 'string'
                                                ? result
                                                : flattenDictionary(result)
                                        );
                                    }}
                                >
                                    <MdContentCopy className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* replace original selection button (first service only, disabled in input mode) */}
                            {index === 0 && (
                                <Tooltip content={t('translate.replace')}>
                                    <Button
                                        isIconOnly
                                        variant='light'
                                        size='sm'
                                        isDisabled={
                                            typeof result !== 'string' ||
                                            result === '' ||
                                            windowType === '[INPUT_TRANSLATE]'
                                        }
                                        onPress={() => {
                                            handleManualReplace().catch((e) => {
                                                toast.error(e.toString(), { style: toastStyle });
                                            });
                                        }}
                                    >
                                        <MdFindReplace className='text-[16px]' />
                                    </Button>
                                </Tooltip>
                            )}
                            {/* translate back button */}
                            <Tooltip content={t('translate.translate_back')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={async () => {
                                        setError('');
                                        let newTargetLanguage = sourceLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newTargetLanguage = detectLanguage;
                                        }
                                        let newSourceLanguage = targetLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newSourceLanguage = 'auto';
                                        }
                                        if (whetherPluginService(currentTranslateServiceInstanceKey)) {
                                            const pluginInfo =
                                                pluginList['translate'][
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                ];
                                            if (
                                                newSourceLanguage in pluginInfo.language &&
                                                newTargetLanguage in pluginInfo.language
                                            ) {
                                                setIsLoading(true);
                                                setHide(true);
                                                const instanceConfig =
                                                    serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                                instanceConfig['enable'] = 'true';
                                                const setHideOnce = invokeOnce(setHide);
                                                let [func, utils] = await invoke_plugin(
                                                    'translate',
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                );
                                                func(
                                                    result.trim(),
                                                    pluginInfo.language[newSourceLanguage],
                                                    pluginInfo.language[newTargetLanguage],
                                                    {
                                                        config: instanceConfig,
                                                        detect: detectLanguage,
                                                        setResult: (v) => {
                                                            setResult(v);
                                                            setHideOnce(false);
                                                        },
                                                        utils,
                                                    }
                                                ).then(
                                                    (v) => {
                                                        if (v === result) {
                                                            setResult(v + ' ');
                                                        } else {
                                                            setResult(v.trim());
                                                        }
                                                        setIsLoading(false);
                                                        if (v !== '') {
                                                            setHideOnce(false);
                                                        }
                                                    },
                                                    (e) => {
                                                        setError(e.toString());
                                                        setIsLoading(false);
                                                    }
                                                );
                                            } else {
                                                setError('Language not supported');
                                            }
                                        } else {
                                            const LanguageEnum =
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                    .Language;
                                            if (
                                                newSourceLanguage in LanguageEnum &&
                                                newTargetLanguage in LanguageEnum
                                            ) {
                                                setIsLoading(true);
                                                setHide(true);
                                                const instanceConfig =
                                                    serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                                const setHideOnce = invokeOnce(setHide);
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                    .translate(
                                                        result.trim(),
                                                        LanguageEnum[newSourceLanguage],
                                                        LanguageEnum[newTargetLanguage],
                                                        {
                                                            config: instanceConfig,
                                                            detect: newSourceLanguage,
                                                            setResult: (v) => {
                                                                setResult(v);
                                                                setHideOnce(false);
                                                            },
                                                        }
                                                    )
                                                    .then(
                                                        (v) => {
                                                            if (v === result) {
                                                                setResult(v + ' ');
                                                            } else {
                                                                setResult(v.trim());
                                                            }
                                                            setIsLoading(false);
                                                            if (v !== '') {
                                                                setHideOnce(false);
                                                            }
                                                        },
                                                        (e) => {
                                                            setError(e.toString());
                                                            setIsLoading(false);
                                                        }
                                                    );
                                            } else {
                                                setError('Language not supported');
                                            }
                                        }
                                    }}
                                >
                                    <TbTransformFilled className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* error retry button */}
                            <Tooltip content={t('translate.retry')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    className={`${error === '' && 'hidden'}`}
                                    onPress={() => {
                                        setError('');
                                        setResult('');
                                        translate();
                                    }}
                                >
                                    <GiCycle className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* available collection service instance */}
                            {collectionServiceList &&
                                collectionServiceList.map((collectionServiceInstanceName) => {
                                    return (
                                        <Button
                                            key={collectionServiceInstanceName}
                                            isIconOnly
                                            variant='light'
                                            size='sm'
                                            onPress={async () => {
                                                if (
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                ) {
                                                    const pluginConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    let [func, utils] = await invoke_plugin(
                                                        'collection',
                                                        getServiceName(collectionServiceInstanceName)
                                                    );
                                                    func(sourceText.trim(), result.toString(), {
                                                        config: pluginConfig,
                                                        utils,
                                                    }).then(
                                                        (_) => {
                                                            toast.success(t('translate.add_collection_success'), {
                                                                style: toastStyle,
                                                            });
                                                        },
                                                        (e) => {
                                                            toast.error(e.toString(), { style: toastStyle });
                                                        }
                                                    );
                                                } else {
                                                    const instanceConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    builtinCollectionServices[
                                                        getServiceName(collectionServiceInstanceName)
                                                    ]
                                                        .collection(sourceText, result, {
                                                            config: instanceConfig,
                                                        })
                                                        .then(
                                                            (_) => {
                                                                toast.success(t('translate.add_collection_success'), {
                                                                    style: toastStyle,
                                                                });
                                                            },
                                                            (e) => {
                                                                toast.error(e.toString(), { style: toastStyle });
                                                            }
                                                        );
                                                }
                                            }}
                                        >
                                            <img
                                                src={
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                        ? pluginList['collection'][
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].icon
                                                        : builtinCollectionServices[
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].info.icon
                                                }
                                                className='h-[16px] w-[16px]'
                                            />
                                        </Button>
                                    );
                                })}
                        </ButtonGroup>
                    </CardFooter>
                </div>
            </animated.div>
        </Card>
    );
}
