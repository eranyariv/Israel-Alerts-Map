<?php
$APIKEY  = 'pr_HllnocGJaCSjPQEzhzNYTmXYNVfNfoWXceDCpeauWEjmjJJmneJpcNBVCAtLTLbo';
$RA_BASE = 'https://redalert.orielhaim.com';

header('Content-Type: application/json; charset=utf-8');

$path = $_GET['_path'] ?? '';
if (!preg_match('#^/api/stats/(history|cities|distribution|summary)$#', $path)) {
    http_response_code(400);
    echo '{"error":"invalid path"}';
    exit;
}

$params = $_GET;
unset($params['_path']);
$qs  = http_build_query($params);
$url = $RA_BASE . $path . ($qs ? "?$qs" : '');

$ctx = stream_context_create(['http' => [
    'method'        => 'GET',
    'header'        => "X-API-Key: $APIKEY\r\nAuthorization: Bearer $APIKEY\r\nAccept: application/json\r\nUser-Agent: yariv.org/1.0",
    'ignore_errors' => true,
    'timeout'       => 15,
]]);

$body = @file_get_contents($url, false, $ctx);
if ($body === false) {
    http_response_code(502);
    echo '{"error":"upstream request failed"}';
    exit;
}

$status = 200;
foreach ((array)($http_response_header ?? []) as $h) {
    if (preg_match('#HTTP/[\d.]+ (\d+)#', $h, $m)) $status = (int)$m[1];
}
http_response_code($status);
echo $body;
