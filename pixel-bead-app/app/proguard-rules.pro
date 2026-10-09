# JS 桥的方法是从网页里按名字反射调的，混淆掉就全废了。
-keepclassmembers class com.byd.pixelbead.PBSBridge {
    public *;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*
