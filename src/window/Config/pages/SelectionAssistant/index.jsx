import { DragDropContext, Draggable, Droppable } from 'react-beautiful-dnd';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, Input, Switch } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import React, { useState, useEffect } from 'react';
import {
    HiTranslate,
    HiOutlineVolumeUp,
} from 'react-icons/hi';
import {
    MdContentCopy,
    MdFindReplace,
    MdMenuBook,
    MdDragIndicator,
} from 'react-icons/md';
import { BiSearch } from 'react-icons/bi';

import { useConfig, useToastStyle } from '../../../../hooks';

const ALL_ACTIONS = ['translate', 'copy', 'search', 'replace', 'speak', 'lookup'];

const ACTION_ICONS = {
    translate: HiTranslate,
    copy: MdContentCopy,
    search: BiSearch,
    replace: MdFindReplace,
    speak: HiOutlineVolumeUp,
    lookup: MdMenuBook,
};

function ActionIcon({ name, className }) {
    const Icon = ACTION_ICONS[name] || HiTranslate;
    return <Icon className={className} />;
}

function reorder(list, startIndex, endIndex) {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    return result;
}

export default function SelectionAssistant() {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    const [actionList, setActionList] = useConfig('selection_action_list', ALL_ACTIONS);
    const [searchUrl, setSearchUrl] = useConfig(
        'search_url',
        'https://www.google.com/search?q=%s'
    );
    const [restoreClipboard, setRestoreClipboard] = useConfig('replace_restore_clipboard', true);
    const [successNotify, setSuccessNotify] = useConfig('replace_success_notify', true);

    // 搜索 URL 本地编辑态：含 %s 才合法并持久化
    const [urlInput, setUrlInput] = useState(searchUrl || '');
    useEffect(() => {
        if (searchUrl !== null) setUrlInput(searchUrl);
    }, [searchUrl]);
    const urlValid = urlInput.includes('%s');

    const visibleActions = (actionList || []).filter((x) => ALL_ACTIONS.includes(x));
    const hiddenActions = ALL_ACTIONS.filter((x) => !visibleActions.includes(x));

    const onDragEnd = (result) => {
        if (!result.destination) return;
        setActionList(reorder(visibleActions, result.source.index, result.destination.index));
    };

    const toggleAction = (key, enabled) => {
        if (enabled) {
            setActionList([...visibleActions, key]);
        } else {
            if (visibleActions.length <= 1) {
                toast.error(t('config.selection_assistant.least_one'), { style: toastStyle });
                return;
            }
            setActionList(visibleActions.filter((x) => x !== key));
        }
    };

    return (
        <>
            <Toaster />
            <Card className='mb-[10px]'>
                <CardBody>
                    <h3 className='mb-[8px]'>{t('config.selection_assistant.action_menu')}</h3>
                    {actionList !== null && (
                        <DragDropContext onDragEnd={onDragEnd}>
                            <Droppable
                                droppableId='actions'
                                direction='vertical'
                            >
                                {(provided) => (
                                    <div
                                        ref={provided.innerRef}
                                        {...provided.droppableProps}
                                    >
                                        {visibleActions.map((key, i) => (
                                            <Draggable
                                                key={key}
                                                draggableId={key}
                                                index={i}
                                            >
                                                {(dragProvided) => (
                                                    <div
                                                        ref={dragProvided.innerRef}
                                                        {...dragProvided.draggableProps}
                                                        className='config-item'
                                                    >
                                                        <div className='flex items-center gap-[8px]'>
                                                            <span
                                                                {...dragProvided.dragHandleProps}
                                                                className='flex cursor-grab text-default-400'
                                                            >
                                                                <MdDragIndicator className='text-[18px]' />
                                                            </span>
                                                            <ActionIcon
                                                                name={key}
                                                                className='text-[18px]'
                                                            />
                                                            <h3 className='my-auto mx-0'>
                                                                {t(`action_menu.${key}`)}
                                                            </h3>
                                                        </div>
                                                        <Switch
                                                            isSelected
                                                            onValueChange={(v) => toggleAction(key, v)}
                                                        />
                                                    </div>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>
                    )}
                    {actionList !== null && hiddenActions.length > 0 && (
                        <div className='mt-[8px]'>
                            <p className='text-tiny text-default-400 mb-[4px]'>
                                {t('config.selection_assistant.disabled_actions')}
                            </p>
                            {hiddenActions.map((key) => (
                                <div
                                    key={key}
                                    className='config-item'
                                >
                                    <div className='flex items-center gap-[8px] text-default-400'>
                                        <ActionIcon
                                            name={key}
                                            className='text-[18px]'
                                        />
                                        <h3 className='my-auto mx-0'>{t(`action_menu.${key}`)}</h3>
                                    </div>
                                    <Switch
                                        isSelected={false}
                                        onValueChange={(v) => toggleAction(key, v)}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                    <p className='text-tiny text-default-400 mt-[4px]'>
                        {t('config.selection_assistant.action_menu_tip')}
                    </p>
                </CardBody>
            </Card>

            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.selection_assistant.search_url')}</h3>
                    </div>
                    {searchUrl !== null && (
                        <Input
                            aria-label='search url'
                            value={urlInput}
                            isInvalid={!urlValid}
                            color={urlValid ? 'default' : 'danger'}
                            onValueChange={(v) => {
                                setUrlInput(v);
                                if (v.includes('%s')) {
                                    setSearchUrl(v);
                                }
                            }}
                        />
                    )}
                    <p className={`text-tiny mt-[4px] ${urlValid ? 'text-default-400' : 'text-danger'}`}>
                        {urlValid
                            ? t('config.selection_assistant.search_url_tip')
                            : t('config.selection_assistant.need_pct_s')}
                    </p>
                </CardBody>
            </Card>

            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>
                            {t('config.selection_assistant.restore_clipboard')}
                        </h3>
                        {restoreClipboard !== null && (
                            <Switch
                                isSelected={restoreClipboard}
                                onValueChange={setRestoreClipboard}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>
                            {t('config.selection_assistant.success_notify')}
                        </h3>
                        {successNotify !== null && (
                            <Switch
                                isSelected={successNotify}
                                onValueChange={setSuccessNotify}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
        </>
    );
}
