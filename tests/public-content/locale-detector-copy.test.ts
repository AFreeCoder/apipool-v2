import assert from 'node:assert/strict';
import test from 'node:test';

import { getLocaleDetectorCopy } from '@/shared/blocks/common/locale-detector-copy';

test('locale detector banner copy follows the detected target locale', () => {
  assert.deepEqual(getLocaleDetectorCopy('zh', '中文'), {
    title: '检测到你的浏览器语言是中文。是否切换？',
    switchTo: '切换到中文',
    close: '关闭语言提示',
  });

  assert.deepEqual(getLocaleDetectorCopy('en', 'English'), {
    title: 'We detected your browser language is English. Switch to it?',
    switchTo: 'Switch to English',
    close: 'Close language suggestion',
  });
});
