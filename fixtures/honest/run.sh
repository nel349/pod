#!/bin/sh
# Stands in for a pod's artefact: does its work, says what it did, and tries two things it should
# not be able to do. The test asserts that both are refused.
echo "worked"
if getent hosts example.com >/dev/null 2>&1; then echo "internet: reachable"; else echo "internet: blocked"; fi
if echo x > /etc/proof 2>/dev/null; then echo "root filesystem: writable"; else echo "root filesystem: read-only"; fi
