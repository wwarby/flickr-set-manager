select
    genealogy,
    name,
    keyword,
    '{ "title": "' || name || '", "keyword": "' || keyword || '" },' as json
    from (select
        c.genealogy,
        c.name,
        substr(content, instr(content, 'value = "') + 9, instr(content, 'value2 = "') - (instr(content, 'value = "') + 14)) as keyword
        from main.AgLibraryCollection as c
            left join main.AgLibraryCollectionContent as cc on c.id_local = cc.collection
        where c.creationId = 'com.adobe.ag.library.smart_collection'
        order by c.name, length(keyword) desc)
    group by genealogy, name
    order by name desc;
