'use strict';

const fs = require('fs');
const Flickr = require('flickr-sdk');
const _ = require('lodash');
const chalk = require('chalk');

const config = JSON.parse(fs.readFileSync('appsettings.json'));
const photosets = JSON.parse(fs.readFileSync('photosets.json'));
const oauth = new Flickr.OAuth(config.apiKey, config.apiSecret);

(async () => {
  try {
    const flickr = new Flickr(oauth.plugin(config.oauthToken, config.oauthTokenSecret));

    const username = (await flickr.test.login()).body?.user?.username?._content || config.userNsid;

    photosets.forEach(x => {
      x.tag = x.keyword.replace(/[^a-zA-Z0-9]+/g, '');
      x.primaryKeyword = `${x.keyword}-primary`;
      x.primaryTag = `${x.tag}primary`;
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
          console.log(`${chalk.yellow(photoset.currentPhotos.length)} current photos found in ${chalk.cyan(photoset.title)}`);
        }

        // Get matched photos for set, and primary photo ID
        photoset.targetPhotos = (await depaginate(flickr.photos.search.bind(flickr.photos), {
          user_id: config.userNsid,
          tags: photoset.keyword,
          extras: 'tags',
          sort: photoset.sort || 'date-taken-desc',
          min_taken_date: photoset.minDate,
          max_taken_date: photoset.maxDate
        }, 'photos', 'photo')) || [];

        // Clean dirty object structure in responses
        photoset.targetPhotos.forEach(x => x.tags = x.tags.split(' '));

        if (!photoset.targetPhotos.length) {
          console.warn(`${chalk.bgRedBright('WARNING')}: No matched photos for ${chalk.cyan(photoset.title)} by keyword ${chalk.magenta(photoset.keyword)}${photoset.minDate ? `, after ${chalk.magenta(photoset.minDate)}` : ''}${photoset.maxDate ? `, before ${chalk.magenta(photoset.maxDate)}` : ''}`);
          return;
        }

        console.log(`${chalk.yellow(photoset.targetPhotos.length)} photos matched for ${chalk.cyan(photoset.title)} by keyword ${chalk.magenta(photoset.keyword)}${photoset.minDate ? `, after ${chalk.magenta(photoset.minDate)}` : ''}${photoset.maxDate ? `, before ${chalk.magenta(photoset.maxDate)}` : ''}`);
        photoset.primaryPhotoId = photoset.targetPhotos.find(x => x.tags.includes(`${photoset.primaryTag}`))?.id;

        if (!photoset.primaryPhotoId) {
          console.warn(`${chalk.bgRedBright('WARNING')}: No primary photo for ${chalk.cyan(photoset.title)} by keyword ${chalk.magenta(photoset.primaryKeyword)}`);
          photoset.primaryPhotoId = photoset.targetPhotos.find(_ => true)?.id;
        } else if (photoset.targetPhotos.filter(x => x.tags.includes(`${photoset.primaryTag}`)).length) {
          console.warn(`${chalk.bgRedBright('WARNING')}: Multiple photos for ${chalk.cyan(photoset.title)} keyworded with ${chalk.magenta(photoset.primaryKeyword)}`);
        }

        if (!photoset.remote) {
          photoset.created = true;
          photoset.remote = (await flickr.photosets.create({
            title: photoset.title,
            description: photoset.description || '',
            primary_photo_id: photoset.primaryPhotoId
          })).body.photoset;
          console.log(`${chalk.yellow('Created')} ${chalk.cyan(photoset.title)} at https://www.flickr.com/photos/${username}/albums/${photoset.remote.id}`);
        }

        if (photoset.currentPhotos?.map(x => x.id).sort().join(',') !== photoset.targetPhotos?.map(x => x.id).sort().join(',') || photoset.primaryPhotoId !== photoset.remote?.primary) {
          await flickr.photosets.editPhotos({
            photoset_id: photoset.remote.id,
            photo_ids: photoset.targetPhotos.map(x => x.id).join(','),
            primary_photo_id: photoset.primaryPhotoId
          });
          if (photoset.created) {
            console.log(`${chalk.yellow('Added')} to ${chalk.yellow(photoset.targetPhotos.length)} photos new photoset ${chalk.cyan(photoset.title)}`);
          } else {
            console.log(`${chalk.yellow('Updated')} ${chalk.cyan(photoset.title)} with ${chalk.yellow(photoset.targetPhotos.length)} photos (previously contained ${chalk.red(photoset.currentPhotos?.length || 0)})`);
          }
        } else {
          console.log(`No update necessary for ${chalk.cyan(photoset.title)}`);
        }
      }));
    }

    console.log(`Sorting ${chalk.yellow(photosets.filter(x => x.remote).length)} sets on Flickr`);
    await flickr.photosets.orderSets({
      photoset_ids: photosets.filter(x => x.remote).map(x => x.remote.id).join(',')
    });

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
    results[root][branch] = results[root][branch].concat((await fn(params)).body[branch]);
  }
  return results[root][branch];
}
