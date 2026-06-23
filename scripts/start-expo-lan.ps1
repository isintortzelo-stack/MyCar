$ErrorActionPreference = "Stop"

function Test-PrivateIpv4Address {
  param([string]$Address)

  return $Address -match '^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$'
}

function Get-ExpoLanHost {
  $adapterBlocks = (ipconfig) -join "`n" -split "`n(?=\S.*adapter )"

  foreach ($block in $adapterBlocks) {
    if ($block -match 'Media disconnected') {
      continue
    }

    if ($block -notmatch 'Default Gateway[^\n]*:\s*(\d{1,3}(\.\d{1,3}){3})') {
      continue
    }

    $ipMatch = [regex]::Match($block, 'IPv4 Address[^\n]*:\s*(\d{1,3}(\.\d{1,3}){3})')
    if ($ipMatch.Success -and (Test-PrivateIpv4Address $ipMatch.Groups[1].Value)) {
      return $ipMatch.Groups[1].Value
    }
  }

  foreach ($match in ([regex]::Matches((ipconfig) -join "`n", 'IPv4 Address[^\n]*:\s*(\d{1,3}(\.\d{1,3}){3})'))) {
    $address = $match.Groups[1].Value
    if (Test-PrivateIpv4Address $address) {
      return $address
    }
  }

  return ""
}

$wifiIp = Get-ExpoLanHost

if (-not $wifiIp) {
  Write-Error "Could not find a private Wi-Fi/hotspot IPv4 address. Check that Wi-Fi or hotspot is connected."
}

$env:REACT_NATIVE_PACKAGER_HOSTNAME = $wifiIp
Write-Host "Using Expo LAN host $wifiIp"

npx expo start --host lan @args
