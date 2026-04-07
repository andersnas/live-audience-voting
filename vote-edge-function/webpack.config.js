import path from 'path';
import webpack from 'webpack';
import SpinSdkPlugin from "@spinframework/build-tools/plugins/webpack/index.js";

const config = async () => {
    let SpinPlugin = await SpinSdkPlugin.init()
    return {
        mode: 'production',
        stats: 'errors-only',
        entry: './src/index.js',
        experiments: {
            outputModule: true,
        },
        resolve: {
            extensions: ['.js'],
        },
        module: {
            rules: [
                {
                test: /\.(html|css)$/,
                use: 'raw-loader'
                }
            ]
        },
        output: {
            path: path.resolve(process.cwd(), './build'),
            filename: 'bundle.js',
            module: true,
            library: {
                type: "module",
            }
        },
        plugins: [
            SpinPlugin,
            new webpack.DefinePlugin({
                __SSE_SERVER_URL__: JSON.stringify(process.env.SSE_SERVER_URL || 'https://{CDN_HOSTNAME}/voterapp/api/vote'),
                __ORIGIN_URL__: JSON.stringify(process.env.ORIGIN_URL || 'https://{ORIGIN_HOSTNAME}/voterapp'),
            })
        ],
        optimization: {
            minimize: false
        },
    };
}
export default config
