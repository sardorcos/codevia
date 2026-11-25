// Front-end libraries bundled with the app for offline use (Tools → Libraries).
// copy-libs.mjs copies these exact dist files to public/libs/<id>/<version>/<name>;
// licenses.mjs adds their licences to THIRD_PARTY_LICENSES.txt.
// Keep in sync with src/tools/libraries/catalog.ts (a unit test checks ids, versions and file names).
export const LIBS = [
  { id: 'tailwindcss', pkg: '@tailwindcss/browser', files: [['dist/index.global.js', 'tailwindcss.js']] },
  {
    id: 'bootstrap',
    pkg: 'bootstrap',
    files: [
      ['dist/css/bootstrap.min.css', 'bootstrap.min.css'],
      ['dist/js/bootstrap.bundle.min.js', 'bootstrap.bundle.min.js'],
    ],
  },
  { id: 'vue', pkg: 'vue', files: [['dist/vue.global.prod.js', 'vue.global.prod.js']] },
  {
    id: 'alpinejs',
    pkg: 'alpinejs',
    files: [['dist/cdn.min.js', 'alpine.min.js']],
    // The npm package ships without a LICENSE file; this is the notice from the project's LICENSE.md.
    copyright: 'Copyright © 2019-2021 Caleb Porzio and contributors',
  },
  { id: 'htmx', pkg: 'htmx.org', files: [['dist/htmx.min.js', 'htmx.min.js']] },
  { id: 'chartjs', pkg: 'chart.js', files: [['dist/chart.umd.min.js', 'chart.umd.min.js']] },
  { id: 'lodash', pkg: 'lodash', files: [['lodash.min.js', 'lodash.min.js']] },
  { id: 'dayjs', pkg: 'dayjs', files: [['dayjs.min.js', 'dayjs.min.js']] },
  { id: 'animatecss', pkg: 'animate.css', files: [['animate.min.css', 'animate.min.css']] },
];

/** Licences we accept for bundled libraries. */
export const PERMISSIVE = /^(MIT|ISC|0BSD|BSD-[23]-Clause|Apache-2\.0)$/;
