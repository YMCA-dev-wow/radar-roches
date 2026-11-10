# Compile l'appli de test « Radar test » (build debug) sur ce PC.
# Outils (Java, SDK Android) dans Documents\Claude\outils_android ; journal : outils_android\journaux\build.log
$outils = "C:\Users\yves.marie.chene_ais\Documents\Claude\outils_android"
$env:JAVA_HOME = "$outils\jdk21"
$env:ANDROID_HOME = "$outils\sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
$racine = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $racine
node copier_www.js
npx cap sync android
Set-Location android
New-Item -ItemType Directory -Force "$outils\journaux" | Out-Null
# -Wait attendrait aussi le démon Gradle (qui reste lancé) : on n'attend que gradlew
$p = Start-Process -FilePath "$racine\android\gradlew.bat" -ArgumentList 'assembleDebug', '--console=plain' -WorkingDirectory "$racine\android" -NoNewWindow -PassThru -RedirectStandardOutput "$outils\journaux\build.log" -RedirectStandardError "$outils\journaux\build_err.log"
$p.WaitForExit()
"FIN code=" + $p.ExitCode
Get-Content "$outils\journaux\build_err.log" -Tail 15
Get-Content "$outils\journaux\build.log" -Tail 25
Pop-Location
