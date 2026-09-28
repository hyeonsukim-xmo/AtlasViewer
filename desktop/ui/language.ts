import { useSyncExternalStore } from "react";
import english from "./locales/en.json";

export type Language = "ko" | "en";
export const languageStorageKey = "exmo.language";
const listeners = new Set<() => void>();
function readLanguage(): Language {
  try {
    return localStorage.getItem(languageStorageKey) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}
let language: Language = readLanguage();
const translations: Record<string, string> = english;
export const getLanguage = () => language;
export const localeTag = () => (language === "en" ? "en-US" : "ko-KR");

export function setLanguage(next: Language) {
  if (next !== "ko" && next !== "en") return;
  language = next;
  try {
    localStorage.setItem(languageStorageKey, next);
  } catch {
    /* Session-only preference. */
  }
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === languageStorageKey || event.key === null) {
      language = readLanguage();
      document.documentElement.lang = language;
      listener();
    }
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, () => "ko" as Language);
}

/** Translate application-owned messages only; never translate user metadata or paths. */
export function t(
  message: string | null | undefined,
  values: Record<string, string | number> = {},
): string {
  const key = message || "";
  const template = language === "en" ? (translations[key] ?? key) : key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}
