// i18n hook — vLAN-CameraHIK
import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import en from './en';
import vi from './vi';

const langs = { en, vi };

/**
 * Resolve a dot-notation key like 'sidebar.liveView' from a language object.
 */
function resolve(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

/**
 * React hook that returns a translator function `t(key)`.
 *
 * Usage:
 *   const { t, language } = useLanguage();
 *   t('sidebar.liveView')  // → 'Live View' or 'Live View' depending on language
 */
export function useLanguage() {
  const language = useStore((s) => s.language);
  const dict = langs[language] || en;

  const t = useMemo(() => {
    return (key, replacements) => {
      let value = resolve(dict, key);
      // Fallback to English if key not found in current language
      if (value === undefined) value = resolve(en, key);
      // Final fallback: return the key itself
      if (value === undefined) return key;
      // Handle template replacements like {level}, {cols}, {rows}
      if (replacements && typeof value === 'string') {
        Object.entries(replacements).forEach(([k, v]) => {
          value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
        });
      }
      return value;
    };
  }, [dict]);

  return { t, language };
}

export default useLanguage;
