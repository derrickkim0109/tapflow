// The Android half of the tree measurement sample (`.work` e2e-followups A2). Same screens and element ids
// as the iOS targets, so `../expected/` and `../measure.ts` read all three the same way.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "TapflowSample"
include(":app")
