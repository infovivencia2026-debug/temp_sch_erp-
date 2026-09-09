/* ---------------------------------------------------------------------------
   DEPLOYMENT MODE

   The same source produces two sites. Built plain it is the multi-industry
   suite: a home page listing five verticals, with an industry switcher in
   every shell. Built with VITE_ONLY_INDUSTRY it is that one vertical on its
   own — the home page redirects into it and the switcher is gone, because on
   a single-vertical site there is nothing to switch to.

   All twenty-one interfaces, every module and every role are identical in
   both; the only difference is whether the other verticals exist.
   --------------------------------------------------------------------------- */

export const ONLY_INDUSTRY = ((import.meta as any).env?.VITE_ONLY_INDUSTRY as string | undefined) || ''

export const isSingleIndustry = ONLY_INDUSTRY.length > 0
