// wrangler's default module rules bundle *.sql as Text (a string).
declare module '*.sql' {
  const text: string
  export default text
}
