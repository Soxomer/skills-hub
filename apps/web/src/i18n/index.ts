import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { resources } from './resources'

const savedLanguage = localStorage.getItem('ahm.language')
const initialLanguage = savedLanguage ?? (navigator.language.startsWith('zh') ? 'zh' : 'en')

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
