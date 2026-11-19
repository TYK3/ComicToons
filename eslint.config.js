import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ignores:['**/dist/**','**/dist-demo/**','node_modules/**','artifacts/**','exports/**','test-results/**']},js.configs.recommended,...ts.configs.recommended,{files:['**/*.{js,mjs,ts,tsx}'],languageOptions:{globals:{process:'readonly',console:'readonly',Buffer:'readonly',URL:'readonly',setInterval:'readonly',clearInterval:'readonly',setTimeout:'readonly',fetch:'readonly',window:'readonly',document:'readonly'}},rules:{'@typescript-eslint/no-explicit-any':'error'}});
