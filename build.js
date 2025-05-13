const https = require('https');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

// 定义不同软件的下载前缀
const downloadPrefixes = {
    jdk: 'https://github.com/shenxinli/java-release/releases/download',
    redis: 'https://github.com/shenxinli/redis-release/releases/download',
    postgresql: 'https://github.com/shenxinli/postgresql-release/releases/download'
};

/**
 * 生成特定软件的下载链接
 * @param {string} software - 软件名称，如 'jdk', 'redis', 'postgresql'
 * @param {string} version - 软件版本号，如 '16'
 * @param {string} platform - 平台，如 'linux', 'windows'
 * @param {string} arch - 架构，如 'amd64', 'arm64', 'x86'
 * @returns {string} 生成的下载链接
 */
function generateDownloadLink(software, version, platform, arch) {
    // Windows 平台的 Redis 固定使用 5 版本
    if (software === 'redis' && platform === 'windows') {
        console.log(`⚠️ Windows 平台的 Redis 固定使用 v5 版本，忽略配置中的 ${version}`);
        version = '5';
    }

    const prefix = downloadPrefixes[software];
    if (!prefix) {
        throw new Error(`Unsupported software: ${software}`);
    }

    let filename;
    if (software === 'postgresql') {
        if (platform === 'windows') {
            filename = `postgresql-${version}-windows-${arch}.zip`;
        } else if (platform === 'linux') {
            filename = `postgresql-${version}-linux-${arch}.tar.gz`;
        } else {
            throw new Error(`Unsupported platform for PostgreSQL: ${platform}`);
        }
    } else if (software === 'redis') {
        if (platform === 'windows') {
            filename = `redis-${version}-windows-${arch}.zip`;
        } else if (platform === 'linux') {
            filename = `redis-${version}-linux-${arch}.tar.gz`;
        } else {
            throw new Error(`Unsupported platform for Redis: ${platform}`);
        }
    } else if (software === 'jdk') {
        if (platform === 'windows') {
            filename = `openjdk-${version}-windows-${arch}.zip`;
        } else if (platform === 'linux') {
            filename = `openjdk-${version}-linux-${arch}.tar.gz`;
        } else {
            throw new Error(`Unsupported platform for JDK: ${platform}`);
        }
    } else {
        // 这里可以根据其他软件的命名规则进行扩展
        filename = `${software}-${version}-${platform}-${arch}.tar.gz`;
    }

    return `${prefix}/v${version}/${filename}`;
}

/**
 * 检查文件是否存在
 */
async function checkFileExists(filePath) {
    try {
        await fsPromises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * 下载文件并显示进度
 * @param {string} url - 文件URL
 * @param {string} destinationPath - 保存路径
 */
async function downloadFile(url, destinationPath) {
    // 检查文件是否已存在
    const fileExists = await checkFileExists(destinationPath);
    if (fileExists) {
        console.log(`文件已存在: ${destinationPath}`);
        return destinationPath;
    }

    // 创建目标文件夹（包括父目录）
    const dirname = path.dirname(destinationPath);
    await fsPromises.mkdir(dirname, { recursive: true });

    const tempPath = `${destinationPath}.tmp`;
    const fileStream = fs.createWriteStream(tempPath);

    console.log(`🔄 开始下载: ${url}`);
    console.log(`   目标路径: ${destinationPath}`);

    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            // 处理 HTTP 重定向
            if (response.statusCode === 302 || response.statusCode === 301) {
                console.log(`🔀 重定向至: ${response.headers.location}`);
                return downloadFile(response.headers.location, destinationPath)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                reject(new Error(`下载失败，状态码: ${response.statusCode}`));
                return;
            }

            // 显示下载进度
            const totalBytes = parseInt(response.headers['content-length'], 10);
            let receivedBytes = 0;
            let lastProgress = 0;

            response.on('data', (chunk) => {
                receivedBytes += chunk.length;
                const progress = Math.floor((receivedBytes / totalBytes) * 100);
                
                // 每5%更新一次进度
                if (progress - lastProgress >= 5) {
                    process.stdout.write(`\r   下载进度: ${progress}% (${formatBytes(receivedBytes)}/${formatBytes(totalBytes)})`);
                    lastProgress = progress;
                }
            });

            response.on('end', () => {
                process.stdout.write('\n');
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(async () => {
                    try {
                        // 下载完成后将临时文件重命名为正式文件
                        await fsPromises.rename(tempPath, destinationPath);
                        console.log(`✅ 下载完成: ${destinationPath}`);
                        resolve(destinationPath);
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        }).on('error', async (err) => {
            // 发生错误时删除临时文件
            try {
                await fsPromises.unlink(tempPath);
            } catch {}
            reject(err);
        });
    });
}

/**
 * 格式化字节为人类可读的格式
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * 读取配置文件
 */
async function readConfig(filePath) {
    try {
        const data = await fsPromises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('读取配置文件失败:', error.message);
        throw error;
    }
}

/**
 * 安装所有软件
 */
async function installAllSoftware(configPath, platform = 'linux', arch = 'amd64') {
    try {
        const config = await readConfig(configPath);
        
        for (const [envName, envConfig] of Object.entries(config)) {
            console.log(`\n===== 开始检查 ${envName} 环境的软件 =====`);
            
            for (const [componentKey, version] of Object.entries(envConfig)) {
                // 移除 '-version' 后缀获取组件名称
                const component = componentKey.replace(/-version$/, '');
                
                try {
                    const downloadUrl = generateDownloadLink(component, version, platform, arch);
                    const destinationDir = path.join(__dirname, arch, envName, 'bin');
                    const destinationFile = path.join(destinationDir, path.basename(downloadUrl));
                    
                    console.log(`\n🔍 检查 ${component} v${version}...`);
                    console.log(`   下载源: ${downloadUrl}`);
                    console.log(`   目标路径: ${destinationFile}`);
                    
                    await downloadFile(downloadUrl, destinationFile);
                    console.log(`🎉 ${component} v${version} 准备就绪`);
                } catch (error) {
                    console.error(`❌ ${component} v${version} 安装失败:`, error.message);
                }
            }
        }
        
        console.log('\n✨ 所有软件检查完成！');
    } catch (error) {
        console.error('安装过程中发生严重错误:', error.message);
        process.exit(1);
    }
}

// 主入口
async function main() {
    const configPath = path.join(__dirname, 'config.json');
    await installAllSoftware(configPath, 'linux', 'amd64');
    await installAllSoftware(configPath, 'linux', 'arm64');
    await installAllSoftware(configPath, 'windows', 'x64');
}

main();    