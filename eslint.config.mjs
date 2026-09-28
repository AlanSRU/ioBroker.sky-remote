import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['admin/**', 'test/**', 'node_modules/**', '.dev-server/**'],
    },
    {
        // In plain JS, JSDoc @type is how types are declared for checkJs — not redundant
        files: ['**/*.js'],
        rules: {
            'jsdoc/check-tag-names': ['warn', { typed: false }],
        },
    },
];
