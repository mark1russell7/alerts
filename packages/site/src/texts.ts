/**
 * The entry of the three pages of the alert texts: the privacy policy, the terms and the opt-in. Each page has only text
 * and the theme button. The toll-free verification of the texts links to these pages.
 */
import { byId, setupTheme } from "@mark1russell7/site-pages/chrome";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");
