<?php
/**
 * Oref API reverse proxy — uses cURL (file_get_contents blocked on shared hosting)
 * Whitelisted hosts only.
 */

$ALLOWED_HOSTS = [
    'oref'              => 'https://www.oref.org.il',
    'oref-http'         => 'http://www.oref.org.il',
    'oref-history'      => 'https://alerts-history.oref.org.il',
    'tzevaadom-api'     => 'https://api.tzevaadom.co.il',
    'tzevaadom-static'  => 'https://www.tzevaadom.co.il',
];

$host = $_GET['host'] ?? '';
$path = $_GET['path'] ?? '';

if (!isset($ALLOWED_HOSTS[$host])) {
    http_response_code(400);
    exit('Invalid host');
}

$path = ltrim($path, '/');
$url  = $ALLOWED_HOSTS[$host] . '/' . $path;

// Pass through query string (excluding our own params)
$qs = $_SERVER['QUERY_STRING'] ?? '';
$qs = preg_replace('/(?:^|&)(?:host|path)=[^&]*/', '', $qs);
$qs = ltrim($qs, '&');
if ($qs !== '') $url .= '?' . $qs;

// Use cURL
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT        => 8,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_HTTPHEADER     => str_starts_with($host, 'tzevaadom') ? [
        'Accept: application/json, text/plain, */*',
        'Origin: https://www.tzevaadom.co.il',
        'Referer: https://www.tzevaadom.co.il/',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ] : [
        'Accept: application/json, text/plain, */*',
        'Referer: https://www.oref.org.il/',
        'X-Requested-With: XMLHttpRequest',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language: he-IL,he;q=0.9,en-US;q=0.8',
    ],
]);

$body    = curl_exec($ch);
$status  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$errCode = curl_errno($ch);
curl_close($ch);

if ($errCode || $body === false) {
    http_response_code(502);
    exit('Proxy error');
}

http_response_code($status ?: 200);
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

echo ($body === '' ? '[]' : $body);
