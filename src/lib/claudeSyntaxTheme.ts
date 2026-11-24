import type { CSSProperties } from 'react';
import { ThemeMode } from '@/contexts/ThemeContext';

export const getClaudeSyntaxTheme = (theme: ThemeMode): Record<string, CSSProperties> => {
  const themes = {
    gray: {
      base: '#e3e8f0',
      background: 'transparent',
      comment: '#71717a',
      punctuation: '#a1a1aa',
      property: '#fbbf24',
      tag: '#a78bfa',
      string: '#34d399',
      function: '#93bbfc',
      keyword: '#d8b4fe',
      variable: '#c084fc',
      operator: '#a1a1aa',
    },
    light: {
      base: '#1f2937',
      background: 'transparent',
      comment: '#9ca3af',
      punctuation: '#6b7280',
      property: '#dc2626',
      tag: '#7c3aed',
      string: '#059669',
      function: '#2563eb',
      keyword: '#9333ea',
      variable: '#8b5cf6',
      operator: '#6b7280',
    },
  };

  const colors = themes[theme] || themes.gray;

  return {
    'code[class*="language-"]': {
      color: colors.base,
      background: colors.background,
      textShadow: 'none',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.875em',
      textAlign: 'left',
      whiteSpace: 'pre',
      wordSpacing: 'normal',
      wordBreak: 'normal',
      wordWrap: 'normal',
      lineHeight: '1.5',
      MozTabSize: '4',
      tabSize: '4',
      WebkitHyphens: 'none',
      MozHyphens: 'none',
      msHyphens: 'none',
      hyphens: 'none',
    },
    'pre[class*="language-"]': {
      color: colors.base,
      background: colors.background,
      textShadow: 'none',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.875em',
      textAlign: 'left',
      whiteSpace: 'pre',
      wordSpacing: 'normal',
      wordBreak: 'normal',
      wordWrap: 'normal',
      lineHeight: '1.5',
      MozTabSize: '4',
      tabSize: '4',
      WebkitHyphens: 'none',
      MozHyphens: 'none',
      msHyphens: 'none',
      hyphens: 'none',
      padding: '1em',
      margin: '0',
      overflow: 'auto',
    },
    ':not(pre) > code[class*="language-"]': {
      background: theme === 'light' 
        ? 'rgba(139, 92, 246, 0.1)' 
        : 'rgba(139, 92, 246, 0.1)',
      padding: '0.1em 0.3em',
      borderRadius: '0.3em',
      whiteSpace: 'normal',
    },
    'comment': {
      color: colors.comment,
      fontStyle: 'italic',
    },
    'prolog': {
      color: colors.comment,
    },
    'doctype': {
      color: colors.comment,
    },
    'cdata': {
      color: colors.comment,
    },
    'punctuation': {
      color: colors.punctuation,
    },
    'namespace': {
      opacity: '0.7',
    },
    'property': {
      color: colors.property,
    },
    'tag': {
      color: colors.tag,
    },
    'boolean': {
      color: colors.property,
    },
    'number': {
      color: colors.property,
    },
    'constant': {
      color: colors.property,
    },
    'symbol': {
      color: colors.property,
    },
    'deleted': {
      color: '#ef4444',
    },
    'selector': {
      color: colors.variable,
    },
    'attr-name': {
      color: colors.variable,
    },
    'string': {
      color: colors.string,
    },
    'char': {
      color: colors.string,
    },
    'builtin': {
      color: colors.tag,
    },
    'url': {
      color: colors.string,
    },
    'inserted': {
      color: colors.string,
    },
    'entity': {
      color: colors.variable,
      cursor: 'help',
    },
    'atrule': {
      color: colors.keyword,
    },
    'attr-value': {
      color: colors.string,
    },
    'keyword': {
      color: colors.keyword,
    },
    'function': {
      color: colors.function,
    },
    'class-name': {
      color: colors.property,
    },
    'regex': {
      color: '#06b6d4',
    },
    'important': {
      color: colors.property,
      fontWeight: 'bold',
    },
    'variable': {
      color: colors.variable,
    },
    'bold': {
      fontWeight: 'bold',
    },
    'italic': {
      fontStyle: 'italic',
    },
    'operator': {
      color: colors.operator,
    },
    'script': {
      color: colors.base,
    },
    'parameter': {
      color: colors.property,
    },
    'method': {
      color: colors.function,
    },
    'field': {
      color: colors.property,
    },
    'annotation': {
      color: colors.comment,
    },
    'type': {
      color: colors.variable,
    },
    'module': {
      color: colors.tag,
    },
  };
};

export const claudeSyntaxTheme = getClaudeSyntaxTheme('gray');