# Bounded canonical loader-list data parser. Sourcing this file runs no commands.
verify_map() {
    local map=$1 rows=$2 label sign path address extra digest
    local loader=/fixture/lib/ld-linux-x86-64.so.2
    local -A expected=() seen=()
    local vdso=0 count=0
    local pointer='^\(0x[0-9a-f]{1,16}\)$'
    local soname='^[A-Za-z0-9_.+-]+$'
    while read -r label path digest extra; do
        [[ $label =~ $soname && $path == "/fixture/lib/$label" &&
           $digest =~ ^[a-f0-9]{64}$ && -z $extra && ! -v expected[$label] ]] || return 1
        expected[$label]=$path
    done < "$map"
    [[ -v expected[ld-linux-x86-64.so.2] && ${#rows} -le 32768 ]] || return 1
    while read -r label sign path address extra; do
        count=$((count+1))
        test "$count" -le 76 || return 1
        if [[ $label == linux-vdso.so.1 && $sign =~ $pointer && -z $path$address$extra ]]; then
            vdso=$((vdso+1))
            continue
        fi
        if [[ $label == "$loader" && $sign =~ $pointer && -z $path$address$extra ]]; then
            label=ld-linux-x86-64.so.2 path=$loader address=$sign sign='=>'
        elif [[ $label == /lib64/ld-linux-x86-64.so.2 ]]; then
            [[ $sign == '=>' && $path == "$loader" ]] || return 1
            label=ld-linux-x86-64.so.2
        fi
        [[ $label =~ $soname && $sign == '=>' && $address =~ $pointer && -z $extra &&
           -v expected[$label] && ! -v seen[$label] && $path == "${expected[$label]}" ]] || return 1
        seen[$label]=1
    done <<< "$rows"
    test "$vdso" -eq 1 && test "${#seen[@]}" -eq "${#expected[@]}"
}
