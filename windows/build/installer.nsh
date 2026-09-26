; Additions to electron-builder's installer (included by electron-builder.yml).

; The installer lets you choose the folder, but "Only for me" runs without administrator rights, and Windows doesn't
; let such an installer write into protected folders like Program Files. Without this check the install gets as far
; as writing the uninstaller and then stops with "Error opening file for writing". This page appears only when
; Setup can't write to the chosen folder, before anything is installed, and says what to do instead.
!macro customPageAfterChangeDir
  !include nsDialogs.nsh

  Var compositorFolderCreated

  Page custom compositorFolderCheck compositorFolderCheckLeave

  Function compositorFolderCheck
    ; As electron-builder's instFilesPre does next: the app goes in a Compositor folder inside the chosen one.
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    Call compositorCanWriteFolder
    Pop $0
    ${If} $0 == "yes"
      Abort ; Nothing to explain: skip this page.
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Choose another folder" "Setup can't write to the folder you chose."
    nsDialogs::Create 1018
    Pop $0
    ${If} $installMode == "all"
      StrCpy $1 `Setup can't create files in:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nThe drive may be read-only or disconnected, or security software may be blocking it. Click Back and choose another folder.`
    ${Else}
      StrCpy $1 `Windows doesn't let Setup create files in:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nYou chose to install Compositor only for you, which doesn't use administrator rights, and folders such as Program Files need them. To continue, either:$\r$\n$\r$\n-  click Back and choose a folder you can write to (the suggested one, in your user folder, always works), or$\r$\n$\r$\n-  click Back twice, choose "Anyone who uses this computer" and allow Windows to make changes when it asks. Then you can install in Program Files.`
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 100% $1
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function compositorFolderCheckLeave
    ; Next checks again, in case the folder's permissions were changed in the meantime.
    Call compositorCanWriteFolder
    Pop $0
    ${If} $0 != "yes"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Setup still can't write to $INSTDIR.$\r$\n$\r$\nClick Back and choose another folder."
      Abort
    ${EndIf}
  FunctionEnd

  ; Pushes "yes" if Setup can create $INSTDIR and a file in it, otherwise "no". Leaves no files behind.
  Function compositorCanWriteFolder
    Push $1
    Push $2
    StrCpy $1 "no"
    StrCpy $compositorFolderCreated "0"
    ${IfNot} ${FileExists} "$INSTDIR\*.*"
      StrCpy $compositorFolderCreated "1"
    ${EndIf}
    ClearErrors
    CreateDirectory "$INSTDIR"
    ${IfNot} ${Errors}
      FileOpen $2 "$INSTDIR\compositor-setup-check.tmp" w
      ${IfNot} ${Errors}
        FileClose $2
        Delete "$INSTDIR\compositor-setup-check.tmp"
        StrCpy $1 "yes"
      ${EndIf}
    ${EndIf}
    ${If} $1 != "yes"
    ${AndIf} $compositorFolderCreated == "1"
      RMDir "$INSTDIR"
    ${EndIf}
    Pop $2
    Exch $1
  FunctionEnd
!macroend
