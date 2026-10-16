$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    $key = $null
    $signer = $null
    try {
        if ($line.Length -gt 24000) { throw 'Request too large' }
        $request = $line | ConvertFrom-Json
        if ($request.installationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'Invalid installation' }
        if ($request.command -notin @('create', 'public', 'sign', 'model-create', 'model-public', 'model-unwrap')) { throw 'Invalid command' }
        $modelKey = $request.command.StartsWith('model-')
        $algorithm = if ($modelKey) { [System.Security.Cryptography.CngAlgorithm]::Rsa } else { [System.Security.Cryptography.CngAlgorithm]::ECDsaP256 }
        $keyName = 'EXMO.Atlas.Internal.' + $request.installationId
        if ($modelKey) { $keyName += '.Model' }
        if ($request.command -in @('create', 'model-create')) {
            # Never overwrite an existing key or fall back to an exportable private key.
            $parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
            $parameters.Provider = $provider
            $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
            $parameters.KeyUsage = if ($modelKey) { [System.Security.Cryptography.CngKeyUsages]::Decryption } else { [System.Security.Cryptography.CngKeyUsages]::Signing }
            if ($modelKey) { $parameters.Parameters.Add((New-Object System.Security.Cryptography.CngProperty('Length', [BitConverter]::GetBytes([int]3072), [System.Security.Cryptography.CngPropertyOptions]::None))) }
            $key = [System.Security.Cryptography.CngKey]::Create($algorithm, $keyName, $parameters)
        } else {
            $key = [System.Security.Cryptography.CngKey]::Open($keyName, $provider)
        }
        if ($key.ExportPolicy -ne [System.Security.Cryptography.CngExportPolicies]::None -or $key.Algorithm -ne $algorithm) { throw 'Key policy mismatch' }
        $usage = if ($modelKey) { [System.Security.Cryptography.CngKeyUsages]::Decryption } else { [System.Security.Cryptography.CngKeyUsages]::Signing }
        if ($key.KeyUsage -ne $usage) { throw 'Key usage mismatch' }
        if ($request.command -eq 'model-unwrap') {
            $bytes = [Convert]::FromBase64String($request.message)
            if ($bytes.Length -ne 384) { throw 'Invalid model key envelope' }
            $signer = New-Object System.Security.Cryptography.RSACng($key)
            $plain = $signer.Decrypt($bytes, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
            try {
                if ($plain.Length -ne 32) { throw 'Invalid model key' }
                $value = [Convert]::ToBase64String($plain)
            } finally { [Array]::Clear($plain, 0, $plain.Length) }
        } elseif ($request.command -eq 'sign') {
            $bytes = [Convert]::FromBase64String($request.message)
            if ($bytes.Length -gt 18000) { throw 'Message too large' }
            $signer = New-Object System.Security.Cryptography.ECDsaCng($key)
            $signer.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
            $value = [Convert]::ToBase64String($signer.SignData($bytes))
        } else {
            $format = if ($modelKey) { New-Object System.Security.Cryptography.CngKeyBlobFormat('RSAPUBLICBLOB') } else { [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob }
            $value = [Convert]::ToBase64String($key.Export($format))
        }
        [Console]::WriteLine((@{id=$request.id; value=$value} | ConvertTo-Json -Compress))
    } catch {
        [Console]::WriteLine((@{id=$request.id; error='Windows installation key unavailable'} | ConvertTo-Json -Compress))
    } finally {
        if ($null -ne $signer) { $signer.Dispose() }
        if ($null -ne $key) { $key.Dispose() }
    }
}
