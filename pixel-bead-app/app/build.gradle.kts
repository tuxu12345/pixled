import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
}

/**
 * 网页资产同步。
 *
 * 真相只有一个：../pixel-bead-studio/（纯前端，浏览器版和车机版共用同一份代码）。
 * 这里把它**原样**拷进 app/src/main/assets/www/，安卓壳不改网页一个字节。
 * 仓库里也提交了同步后的产物，所以即使没有 ../pixel-bead-studio 也能直接构建。
 *
 * 想跳过同步：./gradlew assembleDebug -PskipWebSync
 */
val studioDir = rootProject.file("../pixel-bead-studio")
val wwwDir = file("src/main/assets/www")

val syncWebAssets by tasks.registering(Sync::class) {
    description = "把 pixel-bead-studio 原样同步进 assets/www"
    group = "pixelbead"
    onlyIf { studioDir.isDirectory && !project.hasProperty("skipWebSync") }
    // 网页源码在构建过程中随时可能被改，做增量快照只会得到
    // "Failed to create MD5 hash ... does not exist" 这种假失败，索性不跟踪状态。
    doNotTrackState("assets/www 是网页源码的镜像，每次构建重新同步")
    from(studioDir) {
        exclude("node_modules/**", ".git/**", "*.log", "package-lock.json", ".DS_Store", "tools/**", "*.mjs.bak")
    }
    into(wwwDir)
}

android {
    namespace = "com.byd.pixelbead"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.byd.pixelbead"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // 车机横屏：不声明任何需要动态申请的权限
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ""
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // assets 里是网页，不要压缩（省得 WebView 读出来还要解压）
    androidResources {
        noCompress += listOf("html", "js", "css", "json", "png", "svg", "webp")
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "DebugProbesKt.bin")
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // 只用它一个：WebViewAssetLoader —— 把 assets/www 用 https:// 虚拟源伺服给 WebView。
    // 为什么非要它：file:// 下 ES 模块会被 CORS 拦掉（module script 走 cors 模式），
    // 而 studio 的 js 全是 ES 模块；顺带 localStorage 也能拿到正常 origin。
    implementation("androidx.webkit:webkit:1.11.0")
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(syncWebAssets)
}
