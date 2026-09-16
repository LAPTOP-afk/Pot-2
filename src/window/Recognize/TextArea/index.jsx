import { Card, CardBody, CardFooter, Button, Skeleton, ButtonGroup, Tooltip } from '@nextui-org/react';
import { sendNotification } from '@tauri-apps/api/notification';
import { writeText } from '@tauri-apps/api/clipboard';
import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api';
import { atom, useAtom, useAtomValue } from 'jotai';
import React, { useEffect, useState } from 'react';
import { CgSpaceBetween } from 'react-icons/cg';
import { MdContentCopy } from 'react-icons/md';
import { MdSmartButton } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';

import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../utils/service_instance';
import { currentServiceInstanceKeyAtom, languageAtom, recognizeFlagAtom } from '../ControlArea';
import { invoke_plugin } from '../../../utils/invoke_plugin';
import * as builtinServices from '../../../services/recognize';
import { useConfig } from '../../../hooks';
import { base64Atom } from '../ImageArea';
import { silentModeAtom, pluginListAtom } from '..';

export const textAtom = atom();
let recognizeId = 0;

export default function TextArea(props) {
    const { serviceInstanceConfigMap } = props;
    const [autoCopy] = useConfig('recognize_auto_copy', false);
    const [deleteNewline] = useConfig('recognize_delete_newline', false);
    const [hideWindow] = useConfig('recognize_hide_window', false);
    const [silentAutoCopy] = useConfig('silent_ocr_auto_copy', true);
    const [silentNotify] = useConfig('silent_ocr_notify', true);
    const recognizeFlag = useAtomValue(recognizeFlagAtom);
    const currentServiceInstanceKey = useAtomValue(currentServiceInstanceKeyAtom);
    const language = useAtomValue(languageAtom);
    const base64 = useAtomValue(base64Atom);
    const [loading, setLoading] = useState(false);
    const [text, setText] = useAtom(textAtom);
    const [error, setError] = useState('');
    const pluginList = useAtomValue(pluginListAtom);
    const [silent, setSilent] = useAtom(silentModeAtom);
    const { t } = useTranslation();

    // 静默识别成功：按配置复制/通知，然后清除模式并关闭隐藏窗口
    const handleSilentSuccess = async (v) => {
        if (silentAutoCopy) {
            await writeText(v);
        }
        if (silentNotify) {
            sendNotification({
                title: silentAutoCopy ? t('common.write_clipboard') : 'Pot2',
                body: v,
            });
        }
        await invoke('set_recognize_mode', { mode: '' });
        setTimeout(() => {
            appWindow.close();
        }, 200);
    };

    // 静默识别失败：回退为正常窗口展示错误，避免无反馈
    const handleSilentError = async (e) => {
        await invoke('set_recognize_mode', { mode: '' });
        setSilent(false);
        setError(e.toString());
        setLoading(false);
        appWindow.show();
        appWindow.setFocus(true);
    };

    useEffect(() => {
        setText('');
        setError('');
        if (
            base64 !== '' &&
            currentServiceInstanceKey &&
            autoCopy !== null &&
            deleteNewline !== null &&
            hideWindow !== null &&
            silentAutoCopy !== null &&
            silentNotify !== null
        ) {
            setLoading(true);
            if (getServiceSouceType(currentServiceInstanceKey) === ServiceSourceType.PLUGIN) {
                if (language in pluginList[getServiceName(currentServiceInstanceKey)].language) {
                    let id = nanoid();
                    recognizeId = id;
                    const pluginConfig = serviceInstanceConfigMap[currentServiceInstanceKey] ?? {};

                    invoke_plugin('recognize', getServiceName(currentServiceInstanceKey)).then(([func, utils]) => {
                        func(base64, pluginList[getServiceName(currentServiceInstanceKey)].language[language], {
                            config: pluginConfig,
                            utils,
                        }).then(
                            (v) => {
                                if (recognizeId !== id) return;
                                v = v.trim();
                                if (deleteNewline) {
                                    v = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                }
                                setText(v);
                                setLoading(false);
                                if (silent) {
                                    void handleSilentSuccess(v);
                                    return;
                                }
                                if (autoCopy) {
                                    writeText(v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({
                                                title: t('common.write_clipboard'),
                                                body: v,
                                            });
                                        }
                                    });
                                }
                            },
                            (e) => {
                                if (recognizeId !== id) return;
                                if (silent) {
                                    void handleSilentError(e);
                                    return;
                                }
                                setError(e.toString());
                                setLoading(false);
                            }
                        );
                    }).catch((e) => {
                        // 插件加载/执行入口失败（main.js 缺失等）：静默模式必须复位并回退显示
                        if (recognizeId !== id) return;
                        if (silent) {
                            void handleSilentError(e);
                            return;
                        }
                        setError(e.toString());
                        setLoading(false);
                    });
                } else if (silent) {
                    void handleSilentError(new Error('Language not supported'));
                }
            } else {
                const instanceConfig = serviceInstanceConfigMap[currentServiceInstanceKey] ?? {};
                if (language in builtinServices[getServiceName(currentServiceInstanceKey)].Language) {
                    let id = nanoid();
                    recognizeId = id;
                    builtinServices[getServiceName(currentServiceInstanceKey)]
                        .recognize(
                            base64,
                            builtinServices[getServiceName(currentServiceInstanceKey)].Language[language],
                            {
                                config: instanceConfig,
                            }
                        )
                        .then(
                            (v) => {
                                if (recognizeId !== id) return;
                                v = v.trim();
                                if (deleteNewline) {
                                    v = v.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                }
                                setText(v);
                                setLoading(false);
                                if (silent) {
                                    void handleSilentSuccess(v);
                                    return;
                                }
                                if (autoCopy) {
                                    writeText(v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({
                                                title: t('common.write_clipboard'),
                                                body: v,
                                            });
                                        }
                                    });
                                }
                            },
                            (e) => {
                                if (recognizeId !== id) return;
                                if (silent) {
                                    void handleSilentError(e);
                                    return;
                                }
                                setError(e.toString());
                                setLoading(false);
                            }
                        );
                } else {
                    if (silent) {
                        void handleSilentError(new Error('Language not supported'));
                    } else {
                        setError('Language not supported');
                        setLoading(false);
                    }
                }
            }
        }
    }, [
        base64,
        currentServiceInstanceKey,
        language,
        recognizeFlag,
        autoCopy,
        deleteNewline,
        hideWindow,
        silent,
        silentAutoCopy,
        silentNotify,
    ]);

    return (
        <Card
            shadow='none'
            className='bg-content1 h-full ml-[6px] mr-[12px]'
            radius='10'
        >
            <CardBody className='bg-content1 p-0 h-full'>
                {loading ? (
                    <div className='space-y-3 m-[12px]'>
                        <Skeleton className='w-3/5 rounded-lg'>
                            <div className='h-3 w-3/5 rounded-lg bg-default-200'></div>
                        </Skeleton>
                        <Skeleton className='w-4/5 rounded-lg'>
                            <div className='h-3 w-4/5 rounded-lg bg-default-200'></div>
                        </Skeleton>
                        <Skeleton className='w-2/5 rounded-lg'>
                            <div className='h-3 w-2/5 rounded-lg bg-default-300'></div>
                        </Skeleton>
                    </div>
                ) : (
                    <>
                        {text && (
                            <textarea
                                value={text}
                                className='bg-content1 h-full m-[12px] mb-0 resize-none focus:outline-none'
                                onChange={(e) => {
                                    setText(e.target.value);
                                }}
                            />
                        )}
                        {error && (
                            <textarea
                                value={error}
                                readOnly
                                className='bg-content1 h-full m-[12px] mb-0 resize-none focus:outline-none text-red-500'
                                onChange={(e) => {
                                    setText(e.target.value);
                                }}
                            />
                        )}
                    </>
                )}
            </CardBody>
            <CardFooter className='bg-content1 flex justify-start px-[12px]'>
                <ButtonGroup>
                    <Tooltip content={t('recognize.copy_text')}>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            onPress={() => {
                                writeText(text);
                            }}
                        >
                            <MdContentCopy className='text-[16px]' />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('recognize.delete_newline')}>
                        <Button
                            isIconOnly
                            variant='light'
                            size='sm'
                            onPress={() => {
                                setText(text.replace(/\-\s+/g, '').replace(/\s+/g, ' '));
                            }}
                        >
                            <MdSmartButton className='text-[16px]' />
                        </Button>
                    </Tooltip>
                    <Tooltip content={t('recognize.delete_space')}>
                        <Button
                            isIconOnly
                            variant='light'
                            size='sm'
                            onPress={() => {
                                setText(text.replaceAll(' ', ''));
                            }}
                        >
                            <CgSpaceBetween className='text-[16px]' />
                        </Button>
                    </Tooltip>
                </ButtonGroup>
            </CardFooter>
        </Card>
    );
}
