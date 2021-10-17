'use strict';

const fs = require('fs');
const Flickr = require('flickr-sdk');
const _ = require('lodash');
const chalk = require('chalk');
const commaNumber = require('comma-number')

const config = JSON.parse(fs.readFileSync('appsettings.json'));
const photosets = JSON.parse(fs.readFileSync('photosets.json'));
const oauth = new Flickr.OAuth(config.apiKey, config.apiSecret);

(async () => {
  try {
    const flickr = new Flickr(oauth.plugin(config.oauthToken, config.oauthTokenSecret));

    const username = (await flickr.test.login()).body?.user?.username?._content || config.userNsid;

    photosets.forEach(x => {
      x.tag = x.keyword.replace(/[^a-zA-Z0-9]+/g, '');
      x.primaryKeyword = x.primaryKeyword || `${x.keyword}-primary`;
      x.primaryTag = x.primaryKeyword.replace(/[^a-zA-Z0-9]+/g, '') || `${x.tag}primary`;
    });

    const remotePhotosets = (await depaginate(flickr.photosets.getList.bind(flickr.photosets), {
      user_id: config.userNsid,
      primary_photo_extras: 'tags'
    }, 'photosets', 'photoset')) || [];
    console.log(`Found ${chalk.yellow(remotePhotosets.length)} photosets on Flickr`);

    // Clean dirty object structure in responses
    remotePhotosets.forEach(x => {
      x.title = x.title._content;
      x.description = x.description._content;
    })

    // Warn about any photosets on Flickr not represented in local config
    remotePhotosets.filter(x => !photosets.some(p => p.title === x.title)).forEach(x => console.warn(`${chalk.bgRedBright('WARNING')}: Photoset ${chalk.cyan(x.title)} (https://www.flickr.com/photos/${username}/albums/${x.id}) is orphaned`));

    // Iterate configured photosets in groups for concurrency
    for (let g of _.chunk(photosets, config.workers)) {
      await Promise.all(g.map(async photoset => {
        photoset.remote = remotePhotosets.find(x => x.title === photoset.title);

        // Get current photos for set (if any)
        if (photoset.remote) {
          photoset.currentPhotos = (await depaginate(flickr.photosets.getPhotos.bind(flickr.photosets), {
            photoset_id: photoset.remote.id,
            user_id: config.userNsid,
            extras: 'tags'
          }, 'photoset', 'photo')) || [];
        }

        // Get matched photos for set, and primary photo ID
        photoset.targetPhotos = (await depaginate(flickr.photos.search.bind(flickr.photos), {
          user_id: config.userNsid,
          tags: photoset.keyword,
          tag_mode: photoset.tagMode || 'any',
          extras: 'tags',
          sort: photoset.sort || 'date-taken-asc',
          min_taken_date: photoset.minDate,
          max_taken_date: photoset.maxDate
        }, 'photos', 'photo')) || [];

        // Clean dirty object structure in responses
        photoset.targetPhotos.forEach(x => x.tags = x.tags.split(' '));

        if (!photoset.targetPhotos.length) {
          console.warn(`${chalk.bgRedBright('WARNING')}: No matched photos for ${chalk.cyan(photoset.title)} by keyword ${chalk.magenta(photoset.keyword)}${photoset.minDate ? `, after ${chalk.magenta(photoset.minDate)}` : ''}${photoset.maxDate ? `, before ${chalk.magenta(photoset.maxDate)}` : ''}`);
          return;
        }

        photoset.primaryPhotoId = photoset.targetPhotos.find(x => x.tags.includes(`${photoset.primaryTag}`))?.id;

        if (!photoset.primaryPhotoId) {
          console.warn(`${chalk.bgRedBright('WARNING')}: No primary photo for ${chalk.cyan(photoset.title)} by keyword ${chalk.magenta(photoset.primaryKeyword)}`);
          photoset.primaryPhotoId = photoset.targetPhotos.find(_ => true)?.id;
        } else if (photoset.targetPhotos.filter(x => x.tags.includes(`${photoset.primaryTag}`)).length > 1) {
          console.warn(`${chalk.bgRedBright('WARNING')}: Multiple photos for ${chalk.cyan(photoset.title)} keyworded with ${chalk.magenta(photoset.primaryKeyword)}`);
        }

        if (!photoset.remote) {
          photoset.created = true;
          photoset.remote = (await flickr.photosets.create({
            title: photoset.title,
            description: photoset.description || '',
            primary_photo_id: photoset.primaryPhotoId
          })).body.photoset;
       }

        if (photoset.currentPhotos?.map(x => x.id).sort().join(',') !== photoset.targetPhotos?.map(x => x.id).sort().join(',') || photoset.primaryPhotoId !== photoset.remote?.primary) {
          await flickr.photosets.editPhotos({
            photoset_id: photoset.remote.id,
            photo_ids: photoset.targetPhotos.map(x => x.id).join(','),
            primary_photo_id: photoset.primaryPhotoId
          });
          if (photoset.created) {
            console.log(`${chalk.cyan(photoset.title)} ${chalk.green('created')} with ${chalk.yellow(commaNumber(photoset.targetPhotos.length))} photo${photoset.targetPhotos.length !== 0 ? 's' : ''}`);
          } else {
            const change = photoset.currentPhotos?.length !== photoset.targetPhotos.length
              ? `from ${chalk.red(commaNumber(photoset.currentPhotos?.length || 0))} to ${chalk.yellow(commaNumber(photoset.targetPhotos.length))} photo${photoset.targetPhotos.length !== 0 ? 's' : ''}`
              : 'with new primary photo';
            console.log(`${chalk.cyan(photoset.title)} ${chalk.yellow('updated')} ${change}`);
          }
        } else {
          console.log(chalk.dim(`${chalk.cyan(photoset.title)} unchanged`));
        }
      }));
    }

    await flickr.photosets.orderSets({
      photoset_ids: photosets.filter(x => x.remote).map(x => x.remote.id).join(',')
    });
    console.log(`Re-ordered ${chalk.yellow(commaNumber(photosets.filter(x => x.remote).length))} set${photosets.length !== 0 ? 's' : ''} on Flickr`);

    console.log(chalk.green('DONE!'));
  } catch (e) {
    console.error(e);
  }

  process.exit();
})();

async function depaginate(fn, params, root, branch) {
  params.page = 1;
  params.per_page = 500;
  const results = (await fn(params)).body;
  let end = parseInt(results[root].page, 10) === parseInt(results[root].pages, 10);
  while (!end) {
    params.page++;
    const pageResults = (await fn(params)).body;
    results[root][branch] = results[root][branch].concat(pageResults[root][branch]);
    end = parseInt(pageResults[root].page, 10) >= parseInt(pageResults[root].pages, 10);
  }
  return results[root][branch];
}
