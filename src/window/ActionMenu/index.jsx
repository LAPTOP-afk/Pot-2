import { Button, Card, CardBody } from '@nextui-org/react';
import { BaseDirectory, exists, readTextFile } from '@tauri-apps/api/fs';
import { appWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/api/clipboard';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/api/shell';
import { invoke } from '@tauri-apps/api';
import toast, { Toaster } from 'react-hot-toast';
import { HiOutlineVolumeUp, HiTranslate } from 'react-icons/hi';
import { BiSearch } from 'react-icons/bi';
import { MdContentCopy, MdFindReplace, MdMenuBook } from 'react-icons/md';
import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfig, useToastStyle, useVoice } from '../../hooks';
import { invoke_plugin } from '../../utils/invoke_plugin';
import * as builtinTtsServices from '../../services/tts';
import {
    ServiceSourceType,
    getServiceName,
    getServiceSouceType,
} from '../../utils/service_instance';
import { store } from '../../utils/store';
import { info } from 'tauri-plugin-log-api';

const DEFAULT_ACTION_LIST = ['translate', 'copy', 'search', 'replace', 'speak', 'lookup'];

export default function ActionMenu() {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const speak = useVoice();

    const [text, setText] = useState('');
    const [busy, setBusy] = useState(null);
    // 朗读播放期间为 true：窗口 hide 后屏蔽 blur 自动关闭，避免 webview 销毁导致朗读中断
    const speakingRef = useRef(false);
    const [selectionActionList] = useConfig('selection_action_list', DEFAULT_ACTION_LIST);
    const [searchUrl] = useConfig('search_url', 'https://www.google.com/search?q=%s');
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);

    useEffect(() => {
        invoke('get_text').then((v) => {
            if (typeof v === 'string' && v.trim() !== '') {
                setText(v);
            } else {
                appWindow.close();
            }
        });
        let unlistenNewText = null;
        let unlistenBlur = null;
        listen('new_text', (event) => {
            if (typeof event.payload === 'string' && event.payload.trim() !== '') {
                setText(event.payload);
            }
        }).then((f) => {
            unlistenNewText = f;
        });
        // 点击菜单外部 / 失焦关闭（朗读播放期间除外）
        listen('tauri://blur', () => {
            setTimeout(() => {
                if (!speakingRef.current) {
                    appWindow.close();
                }
            }, 100);
        }).then((f) => {
            unlistenBlur = f;
        });
        return () => {
            unlistenNewText?.();
            unlistenBlur?.();
        };
    }, []);

    const closeMenu = () => appWindow.close();

    const handleTranslate = async () => {
        await invoke('text_translate', { text });
        closeMenu();
    };

    const handleLookup = async () => {
        // 查词复用现有翻译服务列表（将词典类服务排在首位即可得到词典卡片）
        await invoke('text_translate', { text });
        closeMenu();
    };

    const handleCopy = async () => {
        await writeText(text);
        toast.success(t('action_menu.copied'), { style: toastStyle });
        setTimeout(closeMenu, 200);
    };

    const handleSearch = async () => {
        const encoded = encodeURIComponent(text);
        const url = searchUrl.includes('%s') ? searchUrl.replace('%s', encoded) : searchUrl + encoded;
        await open(url);
        closeMenu();
    };

    const handleReplace = async () => {
        await invoke('replace_translate_text', { text });
        closeMenu();
    };

    const handleSpeak = async () => {
        setBusy('speak');
        try {
            const lang = await invoke('lang_detect', { text });
            const instanceKey = ttsServiceList[0];
            let audio = null;
            if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
                const name = getServiceName(instanceKey);
                const infoPath = `plugins/tts/${name}/info.json`;
                if (await exists(infoPath, { dir: BaseDirectory.AppConfig })) {
                    const pluginInfo = JSON.parse(
                        await readTextFile(infoPath, { dir: BaseDirectory.AppConfig })
                    );
                    const langCode = pluginInfo.language[lang];
                    if (!langCode) throw new Error('Language not supported');
                    const config = (await store.get(instanceKey)) ?? {};
                    const [func, utils] = await invoke_plugin('tts', name);
                    audio = await func(text, langCode, { config, utils });
                }
            } else {
                const name = getServiceName(instanceKey);
                const DATA = builtinTtsServices[name];
                const langCode = DATA?.Language?.[lang];
                if (!langCode) throw new Error('Language not supported');
                const config = (await store.get(instanceKey)) ?? {};
                audio = await DATA.tts(text, langCode, { config });
            }
            if (!audio) throw new Error('No TTS audio');
            // 朗读期间隐藏菜单（保留播放）并屏蔽 blur 关闭，播放结束自动关闭
            speakingRef.current = true;
            await appWindow.hide();
            let endTimer = null;
            speak(audio, () => {
                speakingRef.current = false;
                if (endTimer) clearTimeout(endTimer);
                appWindow.close();
            });
            // 兜底：异常未触发 onended 时 30s 后关闭隐藏窗口
            endTimer = setTimeout(() => {
                speakingRef.current = false;
                appWindow.close();
            }, 30000);
        } catch (e) {
            info(`[action_menu] speak failed: ${e}`);
            toast.error(e.toString(), { style: toastStyle });
            speakingRef.current = false;
            appWindow.show().catch(() => {});
            setBusy(null);
        }
    };

    const actionDefs = {
        translate: {
            label: t('action_menu.translate'),
            icon: <HiTranslate className='text-[17px]' />,
            run: handleTranslate,
        },
        copy: {
            label: t('action_menu.copy'),
            icon: <MdContentCopy className='text-[17px]' />,
            run: handleCopy,
        },
        search: {
            label: t('action_menu.search'),
            icon: <BiSearch className='text-[17px]' />,
            run: handleSearch,
        },
        replace: {
            label: t('action_menu.replace'),
            icon: <MdFindReplace className='text-[17px]' />,
            run: handleReplace,
        },
        speak: {
            label: t('action_menu.speak'),
            icon: <HiOutlineVolumeUp className='text-[17px]' />,
            run: handleSpeak,
        },
        lookup: {
            label: t('action_menu.lookup'),
            icon: <MdMenuBook className='text-[17px]' />,
            run: handleLookup,
        },
    };

    const actions = (selectionActionList ?? DEFAULT_ACTION_LIST).filter((key) => key in actionDefs);

    return (
        <div className='bg-transparent h-screen w-screen px-[8px] py-[8px]'>
            <Toaster />
            <Card
                shadow='none'
                className='rounded-[10px] border-1 border-default-100'
            >
                <CardBody className='p-[4px]'>
                    {actions.map((key) => {
                        const action = actionDefs[key];
                        return (
                            <Button
                                key={key}
                                variant='light'
                                radius='sm'
                                className='w-full h-[40px] justify-start gap-[10px] text-[14px] font-normal'
                                isLoading={busy === 'speak' && key === 'speak'}
                                onPress={() => {
                                    action.run().catch((e) => {
                                        toast.error(e.toString(), { style: toastStyle });
                                    });
                                }}
                            >
                                {action.icon}
                                {action.label}
                            </Button>
                        );
                    })}
                </CardBody>
            </Card>
        </div>
    );
}
