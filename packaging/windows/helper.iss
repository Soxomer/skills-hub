#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif
[Setup]
AppId=SkillsHubHelper
AppName=Skills Hub helper
AppVersion={#AppVersion}
AppPublisher=Skills Hub
DefaultDirName={localappdata}\Programs\Skills Hub Helper
DefaultGroupName=Skills Hub
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#PayloadDir}\..\release-assets
OutputBaseFilename=ahm-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\SkillsHubHelper.exe

[Files]
Source: "{#PayloadDir}\ahm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\SkillsHubHelper.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Skills Hub helper"; Filename: "{app}\SkillsHubHelper.exe"

[Registry]
Root: HKCU; Subkey: "Software\Classes\ahm"; ValueType: string; ValueData: "URL:Skills Hub connection"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\ahm"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\ahm\shell\open\command"; ValueType: string; ValueData: """{app}\SkillsHubHelper.exe"" ""%1"""
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "SkillsHubHelper"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\SkillsHubHelper.exe"; Description: "Open Skills Hub helper"; Flags: nowait postinstall skipifsilent

[Code]
function StopExisting(): Boolean;
var ExitCode, Attempt: Integer;
begin
  Result := True;
  if FileExists(ExpandConstant('{app}\ahm.exe')) then begin
    Result := Exec(ExpandConstant('{app}\ahm.exe'), 'worker --stop --wait', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
    if not Result then exit;
  end;
  if CheckForMutexes('SkillsHubHelper') then begin
    Result := Exec(ExpandConstant('{app}\SkillsHubHelper.exe'), '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if not Result then exit;
    for Attempt := 1 to 100 do begin
      if not CheckForMutexes('SkillsHubHelper') then exit;
      Sleep(100);
    end;
    Result := not CheckForMutexes('SkillsHubHelper');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopExisting() then Result := 'The helper is still finishing work. Wait, then retry. No process was killed.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopExisting();
  if not Result then MsgBox('The helper is still finishing work. Wait, then retry uninstalling.', mbInformation, MB_OK);
end;

// No data-directory deletion: skills, project files, library SQLite and credentials are preserved.
