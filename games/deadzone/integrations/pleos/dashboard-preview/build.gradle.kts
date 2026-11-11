plugins { id("com.android.application") }
android {
    namespace = "dev.zride.dashboardpreview"
    compileSdk = 34
    defaultConfig {
        applicationId = "dev.zride.dashboardpreview"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("boolean", "PREVIEW_ONLY", "true")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
