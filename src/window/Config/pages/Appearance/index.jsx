import {
    Button,
    Card,
    CardBody,
    Chip,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Input,
    Slider,
    Switch,
    Tab,
    Tabs,
} from '@nextui-org/react';
import { MdCheck, MdPalette, MdRestartAlt } from 'react-icons/md';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { isValidHex } from '../../../../utils/accent_theme';

// 预设主题色：default 表示不注入覆盖（精确回退内置蓝）
const PRESETS = [
    { id: 'default', color: '#3578e5' },
    { id: 'cyan', color: '#14b8a6' },
    { id: 'green', color: '#22c55e' },
    { id: 'orange', color: '#f97316' },
    { id: 'red', color: '#ef4444' },
    { id: 'pink', color: '#ec4899' },
    { id: 'purple', color: '#8b5cf6' },
    { id: 'indigo', color: '#6366f1' },
    { id: 'sky', color: '#0ea5e9' },
    { id: 'graphite', color: '#525252' },
];

export default function Appearance() {
    const { t } = useTranslation();

    const [appTheme, setAppTheme] = useConfig('app_theme', 'system');
    const [accentColor, setAccentColor] = useConfig('accent_color', '');
    const [accentPreset, setAccentPreset] = useConfig('accent_preset', 'default');
    const [accentAnimations, setAccentAnimations] = useConfig('accent_animations', true);

    const [hexInput, setHexInput] = useState(accentColor || '');
    const [previewMode, setPreviewMode] = useState('follow'); // follow | light | dark

    const applyPreset = (preset) => {
        setAccentPreset(preset.id);
        setAccentColor(preset.id === 'default' ? '' : preset.color);
        setHexInput(preset.id === 'default' ? '' : preset.color);
    };

    const applyCustomHex = (value) => {
        const v = value.trim();
        setHexInput(v);
        if (v === '') {
            return;
        }
        if (!isValidHex(v)) {
            return;
        }
        const normalized =
            '#' +
            v
                .slice(1)
                .split('')
                .map((c, _i, arr) => (arr.length === 3 ? c + c : c))
                .join('')
                .toLowerCase();
        setAccentPreset('custom');
        setAccentColor(normalized);
    };

    const resetAccent = () => {
        setAccentPreset('default');
        setAccentColor('');
        setHexInput('');
    };

    const previewWrapperClass =
        previewMode === 'follow' ? '' : previewMode === 'light' ? 'light' : 'dark';

    return (
        <>
            {/* 显示模式 */}
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('config.appearance.display_mode')}</h3>
                        {appTheme !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>
                                        {t(`config.general.theme.${appTheme}`)}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='app theme'
                                    onAction={(key) => {
                                        setAppTheme(key);
                                    }}
                                >
                                    <DropdownItem key='system'>
                                        {t('config.general.theme.system')}
                                    </DropdownItem>
                                    <DropdownItem key='light'>
                                        {t('config.general.theme.light')}
                                    </DropdownItem>
                                    <DropdownItem key='dark'>
                                        {t('config.general.theme.dark')}
                                    </DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                </CardBody>
            </Card>

            {/* 主题色 */}
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='flex items-center justify-between mb-[12px]'>
                        <h3>{t('config.appearance.accent_color')}</h3>
                        <Button
                            size='sm'
                            variant='bordered'
                            startContent={<MdRestartAlt className='text-[16px]' />}
                            onPress={resetAccent}
                        >
                            {t('config.appearance.reset')}
                        </Button>
                    </div>

                    <div className='flex flex-wrap items-center gap-[12px] mb-[14px]'>
                        {PRESETS.map((p) => {
                            const selected = accentPreset === p.id;
                            return (
                                <button
                                    key={p.id}
                                    type='button'
                                    title={t(`config.appearance.presets.${p.id}`)}
                                    onClick={() => applyPreset(p)}
                                    className='relative h-[30px] w-[30px] rounded-full border-2 border-default-200 hover:scale-110 transition-transform'
                                    style={{ backgroundColor: p.color }}
                                >
                                    {selected && (
                                        <motion.span
                                            layoutId='accent-swatch-ring'
                                            className='absolute -inset-[4px] rounded-full border-[2.5px] border-primary'
                                            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                                        >
                                            <MdCheck
                                                className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[16px] text-white drop-shadow'
                                                style={{
                                                    color:
                                                        p.id === 'default' ||
                                                        ['graphite', 'red', 'purple', 'indigo'].includes(
                                                            p.id
                                                        )
                                                            ? '#fff'
                                                            : '#181818',
                                                }}
                                            />
                                        </motion.span>
                                    )}
                                </button>
                            );
                        })}

                        {/* 自定义颜色 */}
                        <label
                            title={t('config.appearance.custom_color')}
                            className='relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-default-300 text-default-500 hover:border-primary hover:text-primary'
                        >
                            <MdPalette className='text-[16px]' />
                            <input
                                type='color'
                                className='absolute inset-0 h-full w-full cursor-pointer opacity-0'
                                value={isValidHex(hexInput) ? hexInput : '#3578e5'}
                                onChange={(e) => applyCustomHex(e.target.value)}
                            />
                        </label>
                    </div>

                    <div className='flex flex-wrap items-center gap-[10px]'>
                        <Input
                            type='text'
                            variant='bordered'
                            labelPlacement='outside-left'
                            className='max-w-[200px]'
                            value={hexInput}
                            placeholder='#3578e5'
                            onValueChange={(v) => applyCustomHex(v)}
                            isInvalid={hexInput !== '' && !isValidHex(hexInput)}
                            errorMessage={
                                hexInput !== '' && !isValidHex(hexInput)
                                    ? t('config.appearance.invalid_hex')
                                    : ''
                            }
                        />
                        <div className='flex items-center gap-[8px] ml-auto'>
                            <span className='text-small text-default-500'>
                                {t('config.appearance.animations')}
                            </span>
                            {accentAnimations !== null && (
                                <Switch
                                    isSelected={accentAnimations}
                                    onValueChange={(v) => setAccentAnimations(v)}
                                />
                            )}
                        </div>
                    </div>
                </CardBody>
            </Card>

            {/* 实时预览 */}
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='flex items-center justify-between mb-[12px]'>
                        <h3>{t('config.appearance.preview')}</h3>
                        <Tabs
                            size='sm'
                            selectedKey={previewMode}
                            onSelectionChange={(k) => setPreviewMode(k)}
                            aria-label='preview mode'
                        >
                            <Tab key='follow' title={t('config.appearance.follow')} />
                            <Tab key='light' title={t('config.general.theme.light')} />
                            <Tab key='dark' title={t('config.general.theme.dark')} />
                        </Tabs>
                    </div>

                    <div
                        className={`${previewWrapperClass} rounded-medium border-1 border-default-200 p-[16px] bg-content1 text-foreground`}
                    >
                        <div className='flex flex-wrap items-center gap-[10px] mb-[14px]'>
                            <Button color='primary'>{t('config.appearance.preview')}</Button>
                            <Button color='primary' variant='bordered'>
                                Bordered
                            </Button>
                            <Button color='primary' variant='light'>
                                Light
                            </Button>
                            <Chip color='primary' variant='flat'>
                                Chip
                            </Chip>
                            <Switch color='primary' defaultSelected />
                        </div>
                        <div className='mb-[10px]'>
                            <Slider
                                color='primary'
                                label='Slider'
                                defaultValue={60}
                                maxValue={100}
                                className='max-w-[260px]'
                            />
                        </div>
                        <Tabs color='primary' size='sm' aria-label='preview tabs'>
                            <Tab key='t1' title='Tab 1' />
                            <Tab key='t2' title='Tab 2' />
                            <Tab key='t3' title='Tab 3' />
                        </Tabs>
                    </div>
                </CardBody>
            </Card>
        </>
    );
}
