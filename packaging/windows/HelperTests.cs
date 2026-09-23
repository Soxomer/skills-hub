using System;
internal static class HelperTests
{
    private static int Main()
    {
        var good = "ahm://connect?code=abcdefghijklmnopqrstuv&server=https%3A%2F%2Fexample.com";
        var parsed = PairingLink.Parse(good);
        if (parsed[0] != "abcdefghijklmnopqrstuv" || parsed[1] != "https://example.com") throw new Exception("Pairing altered");
        foreach (var value in new[] {
            good + "&code=anothercode123456789", good + "&extra=x", good + "#fragment",
            good.Replace("connect?", "connect/path?"), good.Replace("ahm:", "https:"),
            good.Replace("https%3A", "http%3A"), good.Replace("example.com", "user%40example.com"),
            good.Replace("abcdefghijklmnopqrstuv", "x%22%20--server%20evil"),
            good.Replace("example.com", "example.com%2Fpath"), good.Replace("connect?", "connect:123?")
        }) {
            try { PairingLink.Parse(value); } catch (ArgumentException) { continue; }
            throw new Exception("Accepted invalid pairing link: " + value);
        }
        Console.WriteLine("Pairing validation passed");
        return 0;
    }
}
